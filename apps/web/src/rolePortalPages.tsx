import { Bell, ChevronDown, ChevronsLeft, ChevronsRight, Filter, Menu, MessageSquare, Search, X } from 'lucide-react';
import { BrandWordmark } from './brand.js';
import { InstitutionExamEnginePage } from './examManagerPage.js';
import { listExamQuestions, listInstitutionExams } from './api.js';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthStatus } from './auth.js';
import { AuthControls } from './authControls.js';
import {
  addInstitutionStudent,
  commitStudentRosterImport,
  createInstitutionUnit,
  createOperationsOrganization,
  endInstitutionStudentRelationship,
  getOperationsOrganizationOnboardingStatus,
  getProtectedAccessToken,
  getSecurityContext,
  inviteInstitutionStaff,
  inviteInitialOrganizationAdmin,
  listInstitutionStaff,
  listInstitutionStudents,
  listInstitutionUnits,
  listOperationsInvitations,
  listOperationsOrganizations,
  listOperationsUsersAccess,
  previewStudentRosterImport,
  transitionOrganizationVerification,
  updateInstitutionUnit,
  updateInstitutionStudent,
  updateOperationsOrganization,
  ApiRequestError,
  type ApiHealth,
  type InstitutionStaffDto,
  type InstitutionStudentCreateRequest,
  type InstitutionStudentDto,
  type InstitutionUnitDto,
  type OrganizationManagementDto,
  type OperationsInvitationDto,
  type OperationsUserAccessDto,
  type RosterImportPreviewDto,
} from './api.js';
import { portalFamilyIcons, rolePortals, type RoleFixture, type RoleNavItem, type RolePortalConfig } from './rolePortalConfig.js';
import { RolePreviewProvider, useRolePreviewState } from './rolePortalPreviewState.js';
import { StatusBadge } from './studentComponents.js';
import { OperationsCareerReadinessPanel } from './operationsCareerReadinessPanel.js';
import { EmployerApplicantsPage, EmployerOpportunitiesPage } from './hiringPages.js';
import { AssistantWidget } from './assistantWidget.js';
import { HelpFaqPanel } from './helpFaqPanel.js';
import { ConsentGate } from './consentGate.js';
import { OperationsDashboardV2, V2EmptyState, V2Stat } from './dashboardsV2.js';
import { EmployerDashboardV3, InstitutionDashboardV3 } from './staffDashboardsV3.js';
import { InstitutionInterventionsPage } from './pilotParityPages.js';
import { StaffPilotWrap } from './parityWraps.js';

interface AuthenticatedWorkspaceSummary {
  readonly role: string;
  readonly organizationId: string | null;
}

const institutionWorkspaceRoles = new Set(['INSTITUTION_OWNER', 'INSTITUTION_ADMIN']);

function isInstitutionWorkspace(workspace: AuthenticatedWorkspaceSummary | undefined): workspace is AuthenticatedWorkspaceSummary & { readonly organizationId: string } {
  return Boolean(workspace?.organizationId && institutionWorkspaceRoles.has(workspace.role));
}

// Staff surfaces (dashboard, exam engine) are shared with the wider institution
// staff roles; admin-only management pages keep the narrower set above.
const institutionStaffWorkspaceRoles = new Set(['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER', 'CAREER_COUNSELOR']);

function isInstitutionStaffWorkspace(workspace: AuthenticatedWorkspaceSummary | undefined): workspace is AuthenticatedWorkspaceSummary & { readonly organizationId: string } {
  return Boolean(workspace?.organizationId && institutionStaffWorkspaceRoles.has(workspace.role));
}

function InstitutionWorkspaceError({ title, unauthorized = false }: { readonly title: string; readonly unauthorized?: boolean }): React.ReactElement {
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>{title}</h1><p>{unauthorized ? 'You do not have permission to perform this action.' : 'We could not resolve your institution workspace.'}</p></div></div><p className="form-error" role="alert">{unauthorized ? 'You do not have permission to perform this action.' : 'We could not load your institution workspace. Reference: workspace-context-missing'}</p></section>;
}

export function DemoPortalLauncher({ onNavigate }: { readonly onNavigate: (path: string) => void }): React.ReactElement {
  const groups = ['Student', 'Institution', 'Employer', 'Operations'] as const;
  useEffect(() => {
    document.title = 'Demo previews | ONE';
  }, []);
  return (
    <main className="demo-launcher">
      <section className="demo-hero">
        <span className="eyebrow">ONE product preview</span>
        <h1>Multi-role portal launcher</h1>
        <p><strong>DEMO PREVIEW</strong> - fictional data. Role selection here does not authenticate or authorize a user.</p>
      </section>
      {groups.map((family) => {
        const Icon = portalFamilyIcons[family];
        return <section className="demo-family" key={family}><div className="demo-family-title"><Icon size={20} /><h2>{family}</h2></div><div className="demo-role-grid">{rolePortals.filter((portal) => portal.family === family).map((portal) => <article className={`demo-role-card role-accent-${portal.accent}`} key={portal.key}><span>{portal.subtitle}</span><h3>{portal.roleName}</h3><p>{portal.organization}</p><dl><div><dt>Preview user</dt><dd>{portal.previewUser}</dd></div><div><dt>Backend role</dt><dd>{portal.backendRole}</dd></div><div><dt>Enforcement</dt><dd>{portal.enforcementStatus}</dd></div></dl><button type="button" onClick={() => onNavigate(portal.basePath)}>Open portal</button></article>)}</div></section>;
      })}
    </main>
  );
}

export function RolePortal({ portal, apiHealth, authStatus, authNotice, showDevelopmentIndicators, onNavigate, onSignIn, onSignOut, demoMode = false, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly onNavigate: (path: string) => void; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly demoMode?: boolean; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  return <RolePreviewProvider><RolePortalInner portal={portal} apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} showDevelopmentIndicators={showDevelopmentIndicators} onNavigate={onNavigate} onSignIn={onSignIn} onSignOut={onSignOut} demoMode={demoMode} authenticatedWorkspace={authenticatedWorkspace} /></RolePreviewProvider>;
}

function RolePortalInner({ portal, apiHealth, authStatus, authNotice, showDevelopmentIndicators, onNavigate, onSignIn, onSignOut, demoMode, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly onNavigate: (path: string) => void; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly demoMode: boolean; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const [path, setPath] = useState(normalizeRolePath(window.location.pathname, portal));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [topbarNotice, setTopbarNotice] = useState('');
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const activeRoute = resolveRoute(portal, path);

  useEffect(() => {
    const label = activeRoute?.label ?? (portal.nav[0]?.label ?? 'Dashboard');
    document.title = label === 'Dashboard' || label === 'Overview' ? `${portal.dashboardTitle} | ONE` : `${label} - ${portal.roleName} | ONE`;
  }, [activeRoute, portal]);

  useEffect(() => {
    const onPop = (): void => setPath(normalizeRolePath(window.location.pathname, portal));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  function navigate(nextPath: string): void {
    const routedPath = demoMode && !nextPath.startsWith('/demo/') ? `/demo${nextPath}` : nextPath;
    window.history.pushState(null, '', routedPath);
    setPath(normalizeRolePath(routedPath, portal));
    setDrawerOpen(false);
    onNavigate(routedPath);
  }

  return (
    <ConsentGate>
    <div className={`role-shell role-accent-${portal.accent} ${collapsed ? 'role-sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#role-main">Skip to content</a>
      <RoleSidebar portal={portal} activePath={path} collapsed={collapsed} drawerOpen={drawerOpen} onNavigate={navigate} onCollapse={() => setCollapsed((value) => !value)} onClose={() => { setDrawerOpen(false); menuButtonRef.current?.focus(); }} />
      {drawerOpen ? <button className="drawer-scrim role-scrim" type="button" aria-label={`Close ${portal.roleName} navigation`} onClick={() => setDrawerOpen(false)} /> : null}
      <div className="role-workspace">
        <RoleTopbar portal={portal} apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} showDevelopmentIndicators={showDevelopmentIndicators} menuButtonRef={menuButtonRef} onOpenMenu={() => setDrawerOpen(true)} onMessages={() => { const messagesRoute = portal.nav.find((item) => /messages|communications/i.test(item.label)); if (messagesRoute) navigate(messagesRoute.path); else setTopbarNotice(`${portal.roleName} messaging is backend-dependent and no message route exists for this role.`); }} onNotifications={() => {
          if (demoMode) { setTopbarNotice(`${portal.roleName} notifications preview: 4 local demo alerts are summarized only; no backend notification state was changed.`); return; }
          if (portal.key === 'institution-admin' && isInstitutionWorkspace(authenticatedWorkspace)) {
            const token = getProtectedAccessToken();
            if (!token) { setTopbarNotice('Sign in to load notifications.'); return; }
            void Promise.all([
              listInstitutionExams(token, authenticatedWorkspace.organizationId),
              listExamQuestions(token, authenticatedWorkspace.organizationId, { status: 'UNDER_REVIEW' }),
            ]).then(([examsResponse, reviewResponse]) => {
              const published = examsResponse.assessments.filter((exam) => exam.lifecycleState === 'PUBLISHED').length;
              const completed = examsResponse.assessments.reduce((sum, exam) => sum + exam.completedAttempts, 0);
              setTopbarNotice(`Notifications: ${published} published assessment(s), ${completed} completed attempt(s), ${reviewResponse.questions.length} question(s) awaiting review.`);
            }).catch(() => setTopbarNotice('Notifications could not be loaded right now.'));
            return;
          }
          setTopbarNotice(`${portal.roleName} has no notification sources yet - nothing needs your attention.`);
        }} onSwitch={() => navigate(demoMode ? '/demo' : '/')} onSignIn={onSignIn} onSignOut={onSignOut} demoMode={demoMode} authenticatedWorkspace={authenticatedWorkspace} />
        <main id="role-main" className="role-main">
          {demoMode ? <section className="demo-boundary" role="note"><strong>DEMO PREVIEW</strong><span>Fictional data. This route is not authenticated and does not authorize a user.</span></section> : null}
          <PortalModeNotice portal={portal} notice={topbarNotice} demoMode={demoMode} authenticatedWorkspace={authenticatedWorkspace} />
          {!demoMode && activeRoute?.path === portal.basePath ? <AuthenticatedDashboardChooser portal={portal} routeLabel={activeRoute?.label ?? 'Dashboard'} onNavigate={navigate} authenticatedWorkspace={authenticatedWorkspace} /> : activeRoute?.path === portal.basePath ? <RoleDashboard portal={portal} onNavigate={navigate} /> : <RoleModulePage portal={portal} route={activeRoute ?? portal.nav[0]!} demoMode={demoMode} authenticatedWorkspace={authenticatedWorkspace} />}
        </main>
      </div>
      <AssistantWidget persona={portal.family === 'Employer' ? 'employer' : portal.family === 'Institution' ? 'institution' : 'student'} />
    </div>
    </ConsentGate>
  );
}

function RoleSidebar({ portal, activePath, collapsed, drawerOpen, onNavigate, onCollapse, onClose }: { readonly portal: RolePortalConfig; readonly activePath: string; readonly collapsed: boolean; readonly drawerOpen: boolean; readonly onNavigate: (path: string) => void; readonly onCollapse: () => void; readonly onClose: () => void }): React.ReactElement {
  const groups = [...new Set(portal.nav.map((item) => item.group))];
  return (
    <aside className={`role-sidebar ${drawerOpen ? 'drawer-open' : ''}`} aria-label={`${portal.roleName} navigation`}>
      <div className="role-brand"><BrandWordmark height={28} /><span><strong>ONE</strong><small>{portal.subtitle}</small></span><button className="icon-button sidebar-close" type="button" aria-label={`Close ${portal.roleName} navigation`} onClick={onClose} autoFocus={drawerOpen}><X size={18} /></button></div>
      <nav className="role-nav" aria-label={`Grouped ${portal.roleName} navigation`}>
        {groups.map((group) => <div className="role-nav-group" key={group}><span>{group}</span>{portal.nav.filter((item) => item.group === group).map((item) => { const Icon = item.icon; const active = activePath === item.path; return <button key={item.path} type="button" className={`role-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} aria-label={item.label} title={item.label} onClick={() => onNavigate(item.path)}><Icon size={16} aria-hidden="true" /><span>{item.label}</span></button>; })}</div>)}
      </nav>
      <button className="role-collapse" type="button" onClick={onCollapse} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed}>
        {collapsed ? <ChevronsRight size={16} aria-hidden="true" /> : <ChevronsLeft size={16} aria-hidden="true" />}
        <span>{collapsed ? 'Expand' : 'Collapse'}</span>
      </button>
    </aside>
  );
}

function RoleTopbar({ portal, apiHealth, authStatus, authNotice, showDevelopmentIndicators, menuButtonRef, onOpenMenu, onMessages, onNotifications, onSwitch, onSignIn, onSignOut, demoMode, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly onOpenMenu: () => void; readonly onMessages: () => void; readonly onNotifications: () => void; readonly onSwitch: () => void; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly demoMode: boolean; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const displayName = demoMode ? portal.previewUser : (authStatus.state === 'authenticated' && authStatus.email ? authStatus.email : portal.roleName);
  const displayRole = authenticatedWorkspace?.role ?? portal.roleName;
  // Never surface the raw organization UUID to an end user; it is an internal identifier.
  const displayOrg = authenticatedWorkspace?.organizationId ? portal.subtitle : portal.organization;
  return <header className="role-topbar"><button ref={menuButtonRef} className="icon-button mobile-menu-button" type="button" aria-label={`Open ${portal.roleName} navigation`} onClick={onOpenMenu}><Menu size={20} /></button><span className="role-context">{portal.roleName}</span><span className="role-org">{displayOrg}</span><label className="role-search" role="search"><Search size={16} /><span className="sr-only">Search {portal.roleName} workspace</span><input placeholder={`Search ${portal.family.toLowerCase()} records...`} /></label><div className="role-topbar-actions"><button type="button" className="secondary" onClick={onSwitch}>{demoMode ? 'Switch preview portal' : 'Switch workspace'}</button><button className="icon-button" type="button" aria-label="Messages" onClick={onMessages}><MessageSquare size={17} /></button><button className="icon-button notification" type="button" aria-label="Notifications" onClick={onNotifications}><Bell size={17} /></button><AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />{showDevelopmentIndicators ? <span className={`staff-api-dot ${apiHealth}`}>{apiHealth}</span> : null}<span className="role-profile"><span>{demoMode ? portal.initials : initialsFor(displayName)}</span><span><strong>{displayName}</strong><small>{displayRole}</small></span><ChevronDown size={14} /></span></div></header>;
}

function normalizeRolePath(path: string, portal: RolePortalConfig): string {
  const normalized = normalize(path);
  const withoutDemo = normalized.startsWith('/demo/') ? normalized.slice('/demo'.length) : normalized;
  if (withoutDemo === `/${portal.family.toLowerCase()}`) return portal.basePath;
  return withoutDemo;
}

function PortalModeNotice({ portal, notice, demoMode, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly notice: string; readonly demoMode: boolean; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const { dirty, reset } = useRolePreviewState();
  if (!demoMode && authenticatedWorkspace) {
    return <section className="role-preview-notice" role="note"><span><strong>Signed in as {portal.roleName}</strong> - sections that are not built yet say so plainly instead of showing another role&apos;s data.</span>{notice ? <span role="status">{notice}</span> : null}</section>;
  }
  return <section className="role-preview-notice" role="note"><span><strong>{dirty ? 'Unsaved session changes' : 'Portal preview'}</strong> — role selection here does not authenticate or authorize a user. {portal.enforcementStatus}.</span>{notice ? <span role="status">{notice}</span> : null}{dirty ? <button type="button" className="secondary" onClick={reset}>Reset demo data</button> : null}</section>;
}

function initialsFor(value: string): string {
  const words = value.split(/[@._\-\s]+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || 'U';
}

function AuthenticatedDashboardChooser({ portal, routeLabel, onNavigate, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly routeLabel: string; readonly onNavigate: (path: string) => void; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  if (portal.family === 'Institution' && ['institution-admin', 'placement-officer', 'department-head', 'faculty'].includes(portal.key) && isInstitutionStaffWorkspace(authenticatedWorkspace)) {
    return <InstitutionDashboardV3 institutionId={authenticatedWorkspace.organizationId} basePath={portal.basePath} />;
  }
  if (portal.family === 'Employer') return <EmployerDashboardV3 basePath={portal.basePath} />;
  if (portal.key === 'operations-admin') return <OperationsDashboardV2 basePath={portal.basePath} />;
  return <AuthenticatedRoleSurface portal={portal} routeLabel={routeLabel} onNavigate={onNavigate} />;
}

function AuthenticatedRoleSurface({ portal, routeLabel, onNavigate }: { readonly portal: RolePortalConfig; readonly routeLabel: string; readonly onNavigate: (path: string) => void }): React.ReactElement {
  return <div className="role-dashboard">
    <section className="role-page-heading"><div><span className="eyebrow">Authenticated workspace</span><h1>{portal.dashboardTitle}</h1><p>{routeLabel === 'Dashboard' || routeLabel === 'Overview' ? portal.dashboardSummary : `${routeLabel} is available for this authorized role, but the full role-specific surface is not yet implemented.`}</p></div></section>
    <section className="role-card role-wide"><h2>Role authorization</h2><p>This workspace is mounted only after `/api/v1/security/context` confirms the matching role and organization scope. Fixture people and preview records are not shown in authenticated mode.</p></section>
    <section className="role-card"><h2>Role-owned capabilities</h2><ul className="role-check-list">{portal.allowedOperations.slice(0, 6).map((item) => <li key={item}>{item}</li>)}</ul></section>
    <section className="role-card"><h2>Protected boundaries</h2><ul className="role-check-list">{portal.readOnlyData.map((item) => <li key={item}>{item}</li>)}</ul></section>
    {portal.nav.length > 1 ? <section className="role-card role-wide"><h2>Authorized navigation</h2><div className="role-record-actions">{portal.nav.slice(0, 6).map((item) => <button key={item.path} type="button" className="secondary" onClick={() => onNavigate(item.path)}>{item.label}</button>)}</div></section> : null}
  </div>;
}

function RoleDashboard({ portal, onNavigate }: { readonly portal: RolePortalConfig; readonly onNavigate: (path: string) => void }): React.ReactElement {
  if (portal.key === 'recruiter') return <EmployerRecruiterRealityPage portal={portal} routeLabel="Dashboard" />;
  const { activity, saveView } = useRolePreviewState();
  const [detail, setDetail] = useState<RoleFixture | null>(null);
  const [editing, setEditing] = useState<RoleFixture | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const primaryRecord = portal.records[0]!;
  return (
    <div className="role-dashboard">
      <section className="role-page-heading"><div><span className="eyebrow">{portal.organization}</span><h1>{portal.dashboardTitle}</h1><p>{portal.dashboardSummary}</p></div><button type="button" onClick={() => saveView(portal.key, `${portal.roleName} dashboard view`)}>Create saved dashboard</button></section>
      <section className="role-kpi-grid" aria-label={`${portal.roleName} KPI summary`}>{portal.kpis.map((kpi) => <article className="role-card role-kpi" key={kpi.label}><span>{kpi.label}</span><strong>{kpi.value}</strong><p>{kpi.detail}</p></article>)}</section>
      <section className="role-card role-wide"><div className="role-section-title"><h2>Needs attention now</h2><button type="button" onClick={() => onNavigate(portal.nav[1]?.path ?? portal.basePath)}>Open work queue</button></div><RoleRecordList portal={portal} records={portal.records} primaryRecord={primaryRecord} onDetail={(record, opener) => { openerRef.current = opener; setDetail(record); }} onEdit={(record, opener) => { openerRef.current = opener; setEditing(record); }} /></section>
      <section className="role-card"><h2>Role-owned workflows</h2><ul className="role-check-list">{portal.allowedOperations.slice(0, 6).map((item) => <li key={item}>{item}</li>)}</ul></section>
      <section className="role-card"><h2>Protected boundaries</h2><ul className="role-check-list">{portal.readOnlyData.map((item) => <li key={item}>{item}</li>)}</ul></section>
      <section className="role-card role-wide"><h2>Preview activity</h2>{activity.filter((item) => item.role === portal.key).length ? activity.filter((item) => item.role === portal.key).map((item) => <article className="role-activity" key={item.id}><strong>{item.action}</strong><span>{item.detail}</span></article>) : <p>No preview changes yet.</p>}</section>
      {detail ? <DetailDialog portal={portal} record={detail} openerRef={openerRef} onClose={() => setDetail(null)} /> : null}
      {editing ? <EditDialog portal={portal} record={editing} route={portal.nav[0]!} openerRef={openerRef} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function RoleModulePage({ portal, route, demoMode, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly route: RoleNavItem; readonly demoMode: boolean; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<readonly string[]>([]);
  const [detail, setDetail] = useState<RoleFixture | null>(null);
  const [editing, setEditing] = useState<RoleFixture | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const dense = isDenseManagementRoute(portal, route);
  if (!demoMode && portal.key === 'operations-admin' && route.label === 'Organizations') return <OperationsOrganizationsPage portal={portal} />;
  if (!demoMode && portal.key === 'operations-admin' && route.label === 'Organization Detail') return <OperationsOrganizationsPage portal={portal} />;
  if (!demoMode && portal.key === 'operations-admin' && route.label === 'Users') return <OperationsUsersAccessPage />;
  if (!demoMode && portal.key === 'operations-admin' && route.label === 'User Detail') return <OperationsUsersAccessPage />;
  if (!demoMode && portal.key === 'operations-admin' && route.label === 'Content Management') return <OperationsContentReadOnlyPage />;
  if (!demoMode && portal.key === 'operations-admin' && /system health|audit logs|security|ai operations/i.test(route.label)) return <OperationsTechnicalReadOnlyPage routeLabel={route.label} />;
  if (!demoMode && portal.key === 'operations-admin' && /verification/i.test(route.label)) return <OperationsOrganizationsPage portal={portal} />;
  if (!demoMode && portal.key === 'operations-admin' && /trust and safety|subscriptions|billing|analytics|feature flags|support|settings/i.test(route.label)) return <AuthenticatedNotYetAvailable title={route.label} detail="This Operations module is not yet backed by a Phase 2A persistent workflow." />;
  if (!demoMode && portal.key === 'institution-admin' && ['Students', 'Student Detail'].includes(route.label)) {
    return <StaffPilotWrap title="Students" subtitle="Roster, readiness and the lifecycle of every student relationship.">
      <InstitutionStudentsPage portal={portal} authenticatedWorkspace={authenticatedWorkspace} /></StaffPilotWrap>;
  }
  if (!demoMode && portal.key === 'institution-admin' && route.label === 'Academic Structure') return <InstitutionAcademicStructurePage portal={portal} authenticatedWorkspace={authenticatedWorkspace} />;
  if (!demoMode && route.label === 'Help & FAQ') return <HelpFaqPanel persona={portal.family === 'Employer' ? 'employer' : 'institution'} />;
  if (!demoMode && portal.family === 'Institution' && route.label === 'Interventions') {
    return isInstitutionStaffWorkspace(authenticatedWorkspace)
      ? <InstitutionInterventionsPage institutionId={authenticatedWorkspace.organizationId} basePath={portal.basePath} />
      : <InstitutionWorkspaceError title="Interventions" />;
  }
    if (!demoMode && ['institution-admin', 'placement-officer', 'department-head', 'faculty'].includes(portal.key) && route.label === 'Assessments') {
      return isInstitutionStaffWorkspace(authenticatedWorkspace)
        ? <StaffPilotWrap title="Assessments" subtitle="Create, publish and track assessments over the governed question bank.">
            <InstitutionExamEnginePage institutionId={authenticatedWorkspace.organizationId} canApprove={portal.key !== 'faculty'} /></StaffPilotWrap>
        : <InstitutionWorkspaceError title='Assessments' />;
    }
  if (!demoMode && portal.key === 'institution-admin' && route.label === 'Staff') return <InstitutionStaffPage portal={portal} authenticatedWorkspace={authenticatedWorkspace} />;
  if (!demoMode && portal.key === 'institution-admin' && /career readiness|placement|reports/i.test(route.label)) return <AuthenticatedReadOnlyModule title={route.label} detail="Institution reports and readiness information are read-only in Phase 2A unless a dedicated persistent mutation is available." />;
  if (!demoMode && portal.key === 'institution-admin' && /settings/i.test(route.label)) return <AuthenticatedNotYetAvailable title={route.label} detail="Institution settings mutation is not yet available in this UAT slice." />;
  if (!demoMode && portal.key === 'recruiter') return <EmployerRecruiterRealityPage portal={portal} routeLabel={route.label} />;
  if (!demoMode && ['faculty', 'department-head'].includes(portal.key)) return <AuthenticatedReadOnlyModule title={route.label} detail="This authenticated staff role can view authorized context only in Phase 2A. Assessment, task, resource, workload, intervention, and meeting mutations are disabled until persistent APIs exist." />;
  if (!demoMode) return <AuthenticatedNotYetAvailable title={route.label} detail="This authenticated module has no approved persistent Phase 2A workflow yet." />;
  const categories = [...new Set(portal.records.map((record) => record.category))];
  const records = portal.records.filter((record) => {
    const filterMatch = filters.length === 0 || filters.includes(record.category) || filters.includes(record.status);
    const textMatch = `${record.title} ${record.owner} ${record.status} ${record.category} ${record.detail}`.toLowerCase().includes(query.toLowerCase());
    return filterMatch && textMatch;
  });

  return (
    <section className={`role-module ${dense ? 'role-module--dense' : ''}`}>
      {portal.key === 'operations-admin' && /content management|system health|audit logs|security/i.test(route.label)
        ? <OperationsCareerReadinessPanel /> : null}
      <div className="role-page-heading"><div><span className="eyebrow">{portal.roleName}</span><h1>{route.label}</h1><p>{moduleDescription(portal, route)} Preview data only; backend authorization remains authoritative.</p></div><button type="button" onClick={(event) => { openerRef.current = event.currentTarget; setEditing(portal.records[0]!); }}>{primaryAction(portal, route)}</button></div>
      <div className="role-card role-filters"><label className="role-local-search"><span>Search {route.label}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${route.label.toLowerCase()}...`} /></label><div className="filter-row" aria-label={`${route.label} filters`}>{categories.map((category) => <button key={category} type="button" aria-pressed={filters.includes(category)} className={filters.includes(category) ? 'selected' : ''} onClick={() => setFilters((value) => value.includes(category) ? value.filter((item) => item !== category) : [...value, category])}><Filter size={14} />{category}</button>)}{filters.length ? <button type="button" className="secondary" onClick={() => setFilters([])}>Clear filters</button> : null}</div><p className="result-count" role="status">{records.length} records shown</p></div>
      {records.length ? <RoleRecordList portal={portal} records={records} dense={dense} onDetail={(record, opener) => { openerRef.current = opener; setDetail(record); }} onEdit={(record, opener) => { openerRef.current = opener; setEditing(record); }} /> : <section className="role-empty"><h2>No records match these filters</h2><p>Clear filters or search text to restore the preview records.</p><button type="button" onClick={() => { setQuery(''); setFilters([]); }}>Clear filters</button></section>}
      <section className="role-card role-wide"><h2>Ownership boundaries</h2><div className="role-boundary-grid"><div><strong>Allowed in preview</strong><ul>{portal.allowedOperations.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>Read-only</strong><ul>{portal.readOnlyData.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>Forbidden</strong><ul>{portal.forbiddenOperations.map((item) => <li key={item}>{item}</li>)}</ul></div></div></section>
      {detail ? <DetailDialog portal={portal} record={detail} openerRef={openerRef} onClose={() => setDetail(null)} /> : null}
      {editing ? <EditDialog portal={portal} record={editing} route={route} openerRef={openerRef} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function RoleRecordList({ portal, records, primaryRecord, dense = false, onDetail, onEdit }: { readonly portal: RolePortalConfig; readonly records: readonly RoleFixture[]; readonly primaryRecord?: RoleFixture; readonly dense?: boolean; readonly onDetail?: (record: RoleFixture, opener: HTMLElement) => void; readonly onEdit?: (record: RoleFixture, opener: HTMLElement) => void }): React.ReactElement {
  const { openDetail } = useRolePreviewState();
  if (dense) return <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} preview records</caption><thead><tr><th scope="col">Record</th><th scope="col">Category / Type</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>{records.map((record) => <tr className="role-record-row" key={record.id} data-primary={primaryRecord?.id === record.id || undefined}><th scope="row"><strong>{record.title}</strong><span>{record.detail}</span><small>{record.protectedNote}</small></th><td>{record.category}</td><td>{record.owner}</td><td><StatusBadge label={record.status} tone="info" /></td><td><div className="role-record-actions"><button type="button" onClick={(event) => { openDetail(portal.key, record); onDetail?.(record, event.currentTarget); }}>View detail</button><button type="button" className="secondary" onClick={(event) => onEdit?.(record, event.currentTarget)}>Edit preview</button></div></td></tr>)}</tbody></table></div>;
  return <div className="role-record-grid">{records.map((record) => <article className="role-record-card" key={record.id} data-primary={primaryRecord?.id === record.id || undefined}><div><span>{record.category}</span><h3>{record.title}</h3><p>{record.detail}</p></div><dl><div><dt>Owner</dt><dd>{record.owner}</dd></div><div><dt>Status</dt><dd><StatusBadge label={record.status} tone="info" /></dd></div></dl><p className="staff-readonly-note">{record.protectedNote}</p><div className="role-record-actions"><button type="button" onClick={(event) => { openDetail(portal.key, record); onDetail?.(record, event.currentTarget); }}>View detail</button><button type="button" className="secondary" onClick={(event) => onEdit?.(record, event.currentTarget)}>Edit preview</button></div></article>)}</div>;
}

function OperationsOrganizationsPage({ portal }: { readonly portal: RolePortalConfig }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [organizations, setOrganizations] = useState<readonly OrganizationManagementDto[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ q: '', kind: '', verification: '' });
  const [form, setForm] = useState({ kind: 'INSTITUTION', legalName: '', displayName: '', countryCode: 'IN', city: '', adminEmail: '' });
  const load = useMemo(() => async (signal?: AbortSignal) => {
    if (!token) return;
    const result = await listOperationsOrganizations(token, filters, signal);
    setOrganizations(result.organizations);
  }, [filters, token]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(() => setError('Unable to load organizations for this Operations identity.'));
    return () => controller.abort();
  }, [load]);
  if (!token) return <RestrictedApiState title="Organizations" message="Sign in with an Operations identity to manage organizations." />;
  const pending = organizations.filter((org) => ['PENDING', 'UNDER_REVIEW'].includes(org.verificationState)).length;
  const verified = organizations.filter((org) => org.verificationState === 'VERIFIED').length;
  const suspended = organizations.filter((org) => org.verificationState === 'SUSPENDED').length;
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await createOperationsOrganization(token!, { kind: form.kind, legalName: form.legalName, profile: { displayName: form.displayName, countryCode: form.countryCode, city: form.city, primaryContactEmail: form.adminEmail } });
      setForm({ kind: 'INSTITUTION', legalName: '', displayName: '', countryCode: 'IN', city: '', adminEmail: '' });
      setNotice('Organization created. Send the initial administrator invitation separately when ready.');
      await load();
    } catch {
      setError('Create organization failed. Check required fields and authorization.');
    }
  }
  async function transition(id: string, toState: string): Promise<void> {
    setError('');
    try {
      await transitionOrganizationVerification(token!, id, toState);
      setNotice(`Verification moved to ${toState}.`);
      await load();
    } catch {
      setError('Verification transition was rejected by policy.');
    }
  }
  async function invite(id: string): Promise<void> {
    const email = window.prompt('Initial administrator email');
    if (!email) return;
    try {
      await inviteInitialOrganizationAdmin(token!, id, email);
      setNotice('Initial administrator invitation persisted.');
      await load();
    } catch {
      setError('Initial administrator invitation failed.');
    }
  }
  async function onboarding(id: string): Promise<void> {
    try {
      const result = await getOperationsOrganizationOnboardingStatus(token!, id);
      setNotice(`Onboarding status: ${JSON.stringify(result.status)}`);
    } catch {
      setError('Onboarding status could not be loaded.');
    }
  }
  async function edit(org: OrganizationManagementDto): Promise<void> {
    const legalName = window.prompt('Legal name', org.legalName);
    if (!legalName) return;
    const city = window.prompt('City', org.profile.city ?? '') ?? org.profile.city ?? '';
    try {
      await updateOperationsOrganization(token!, org.id, { legalName, profile: { displayName: org.profile.displayName ?? '', countryCode: org.profile.countryCode ?? 'IN', city, primaryContactEmail: org.profile.primaryContactEmail ?? '', websiteUrl: org.profile.websiteUrl ?? '', institutionType: org.profile.institutionType ?? undefined } });
      setNotice('Organization details updated.');
      await load();
    } catch {
      setError('Organization update failed. Check required fields and authorization.');
    }
  }
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Organizations</h1><p>Manage platform organization onboarding. Operations can create, verify, suspend and invite initial administrators, but cannot manage students here.</p></div></div>
    <section className="role-kpi-grid" aria-label="Organization lifecycle summary"><article className="role-card role-kpi"><span>Total</span><strong>{organizations.length}</strong><p>Institutions and employers</p></article><article className="role-card role-kpi"><span>Pending / Review</span><strong>{pending}</strong><p>Need Operations action</p></article><article className="role-card role-kpi"><span>Verified</span><strong>{verified}</strong><p>Approved organizations</p></article><article className="role-card role-kpi"><span>Suspended</span><strong>{suspended}</strong><p>No student controls exposed</p></article></section>
    <section className="role-card role-wide"><h2>Search and filters</h2><div className="role-management-form"><label><span>Search</span><input value={filters.q} onChange={(event) => setFilters((value) => ({ ...value, q: event.target.value }))} placeholder="Legal/display name" /></label><label><span>Type</span><select value={filters.kind} onChange={(event) => setFilters((value) => ({ ...value, kind: event.target.value }))}><option value="">All</option><option>INSTITUTION</option><option>EMPLOYER</option></select></label><label><span>Verification</span><select value={filters.verification} onChange={(event) => setFilters((value) => ({ ...value, verification: event.target.value }))}><option value="">All</option><option>PENDING</option><option>UNDER_REVIEW</option><option>VERIFIED</option><option>REJECTED</option><option>SUSPENDED</option></select></label></div></section>
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void create(event)}><h2>Add Organization</h2><label><span>Type *</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value }))}><option value="INSTITUTION">Institution</option><option value="EMPLOYER">Employer</option></select></label><label><span>Legal Name *</span><input value={form.legalName} onChange={(event) => setForm((value) => ({ ...value, legalName: event.target.value }))} required /></label><label><span>Display Name</span><input value={form.displayName} onChange={(event) => setForm((value) => ({ ...value, displayName: event.target.value }))} /></label><label><span>Country *</span><input value={form.countryCode} onChange={(event) => setForm((value) => ({ ...value, countryCode: event.target.value.toUpperCase() }))} maxLength={2} required /></label><label><span>City</span><input value={form.city} onChange={(event) => setForm((value) => ({ ...value, city: event.target.value }))} /></label><label><span>Primary Admin Email</span><input type="email" value={form.adminEmail} onChange={(event) => setForm((value) => ({ ...value, adminEmail: event.target.value }))} /></label><button type="submit">Create organization</button></form>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} real organizations</caption><thead><tr><th>Organization</th><th>Kind</th><th>Location</th><th>Contact</th><th>Verification</th><th>Initial Admin</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{organizations.map((org) => <tr key={org.id} className="role-record-row"><th scope="row"><strong>{org.profile.displayName || org.legalName}</strong><span>{org.legalName}</span><small>{org.profile.websiteUrl ?? 'No website'}</small></th><td>{org.kind}</td><td>{[org.profile.city, org.profile.stateOrProvince, org.profile.countryCode, org.profile.postalCode].filter(Boolean).join(', ') || 'Not set'}</td><td>{org.profile.primaryContactEmail ?? 'Not set'}</td><td><StatusBadge label={org.verificationState} tone="info" /></td><td>{org.initialAdminInvitation?.email ?? 'Not invited'}</td><td>{new Date(org.updatedAt).toLocaleDateString()}</td><td><div className="role-record-actions"><button type="button" className="secondary" onClick={() => void edit(org)}>Edit details</button><button type="button" className="secondary" onClick={() => void onboarding(org.id)}>Onboarding</button>{org.verificationState === 'PENDING' ? <button type="button" onClick={() => void transition(org.id, 'UNDER_REVIEW')}>Begin review</button> : null}{org.verificationState === 'UNDER_REVIEW' ? <><button type="button" onClick={() => void transition(org.id, 'VERIFIED')}>Verify</button><button type="button" className="secondary" onClick={() => void transition(org.id, 'REJECTED')}>Reject</button></> : null}{org.verificationState === 'VERIFIED' ? <button type="button" className="secondary" onClick={() => void transition(org.id, 'SUSPENDED')}>Suspend</button> : null}<button type="button" className="secondary" onClick={() => void invite(org.id)}>Invite admin</button></div></td></tr>)}</tbody></table></div>
    <section className="role-card role-wide"><h2>Operations boundary</h2><p>Student add/import/transfer controls are intentionally absent from Operations. Those workflows belong to Institution Administration.</p></section>
  </section>;
}

function InstitutionStudentsPage({ portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [students, setStudents] = useState<readonly InstitutionStudentDto[]>([]);
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [preview, setPreview] = useState<RosterImportPreviewDto | null>(null);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [studentError, setStudentError] = useState('');
  const [csvError, setCsvError] = useState('');
  const [relationshipError, setRelationshipError] = useState('');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ fullName: '', institutionStudentId: '', email: '', departmentUnitId: '', programUnitId: '', batchUnitId: '', sectionUnitId: '', academicStartDate: '', expectedGraduationDate: '' });
  const [csv, setCsv] = useState('institution_student_id,full_name,email,department,program,batch,section\n');
  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    Promise.all([
      listInstitutionStudents(token, institutionId, controller.signal),
      listInstitutionUnits(token, institutionId, controller.signal),
    ]).then(([studentResult, unitResult]) => {
      setStudents(studentResult.students);
      setUnits(unitResult.units);
    }).catch((error: unknown) => setLoadError(formatApiError(error, 'Unable to load institution students.')));
    return () => controller.abort();
  }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Students" message="Sign in with an Institution Admin identity to manage students." />;
  if (authenticatedWorkspace && !institutionWorkspaceRoles.has(authenticatedWorkspace.role)) return <InstitutionWorkspaceError title="Students" unauthorized />;
  if (!isInstitutionWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Students" />;
  const filteredStudents = students.filter((student) => `${student.fullName} ${student.email} ${student.institutionStudentId}`.toLowerCase().includes(query.toLowerCase()));
  const unitsByKind = (kind: string): readonly InstitutionUnitDto[] => units.filter((unit) => unit.kind === kind);
  async function addStudent(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStudentError('');
    setNotice('');
    try {
      await addInstitutionStudent(token!, institutionId, cleanStudentPayload(form));
      setForm({ fullName: '', institutionStudentId: '', email: '', departmentUnitId: '', programUnitId: '', batchUnitId: '', sectionUnitId: '', academicStartDate: '', expectedGraduationDate: '' });
      setNotice('Student added with institution relationship; global identity was not hard-deleted or bypassed.');
    } catch (error) {
      setStudentError(formatApiError(error, 'Add student failed.'));
    }
  }
  async function editStudent(student: InstitutionStudentDto): Promise<void> {
    const fullName = window.prompt('Student full name', student.fullName);
    if (!fullName || fullName.trim() === student.fullName) return;
    setStudentError('');
    setNotice('');
    try {
      await updateInstitutionStudent(token!, institutionId, student.id, { fullName: fullName.trim() });
      setNotice('Student institution data updated.');
    } catch (error) {
      setStudentError(formatApiError(error, 'Student update failed.'));
    }
  }
  async function relationship(studentId: string, state: string): Promise<void> {
    const effectiveTo = window.prompt(`Confirm ${state}. Effective date/time (ISO or YYYY-MM-DD)`, new Date().toISOString());
    if (!effectiveTo) return;
    if (!window.confirm(`This will mark the current relationship ${state} effective ${effectiveTo}. Historical identity is retained. Continue?`)) return;
    setRelationshipError('');
    setNotice('');
    try {
      await endInstitutionStudentRelationship(token!, institutionId, studentId, state, effectiveTo);
      setNotice(`Student relationship marked ${state}.`);
    } catch (error) {
      setRelationshipError(formatApiError(error, 'Relationship update failed.'));
    }
  }
  async function previewImport(): Promise<void> {
    setCsvError('');
    setNotice('');
    try {
      const result = await previewStudentRosterImport(token!, institutionId, 'uat-roster.csv', csv);
      setPreview(result.import);
    } catch (error) {
      setCsvError(formatApiError(error, 'CSV preview failed validation.'));
    }
  }
  async function commitImport(): Promise<void> {
    if (!preview) return;
    setCsvError('');
    setStudentError('');
    setRelationshipError('');
    await commitStudentRosterImport(token!, institutionId, preview.id);
    setNotice('Roster import committed.');
    setPreview(null);
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Students</h1><p>Institution-owned roster and relationship lifecycle. This is not an Operations workflow.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🎓" tone="blue" value={students.length} label="Students on roster" />
      <V2Stat icon="✅" tone="green" value={students.filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE').length} label="Active" />
      <V2Stat icon="🏛️" tone="purple" value={units.length} label="Academic units" />
      <V2Stat icon="🔎" tone="amber" value={filteredStudents.length} label="Matching search" />
    </div>
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}{relationshipError ? <p className="form-error" role="alert">{relationshipError}</p> : null}{notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void addStudent(event)}><h2>Add Student</h2>{studentError ? <p className="form-error" role="alert">{studentError}</p> : null}<label><span>Full name *</span><input value={form.fullName} onChange={(event) => setForm((value) => ({ ...value, fullName: event.target.value }))} required /></label><label><span>Institution ID *</span><input value={form.institutionStudentId} onChange={(event) => setForm((value) => ({ ...value, institutionStudentId: event.target.value }))} required /></label><label><span>Email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label><UnitSelect label="Department" value={form.departmentUnitId} units={unitsByKind('DEPARTMENT')} onChange={(departmentUnitId) => setForm((value) => ({ ...value, departmentUnitId }))} /><UnitSelect label="Program" value={form.programUnitId} units={unitsByKind('PROGRAM')} onChange={(programUnitId) => setForm((value) => ({ ...value, programUnitId }))} /><UnitSelect label="Batch" value={form.batchUnitId} units={unitsByKind('BATCH')} onChange={(batchUnitId) => setForm((value) => ({ ...value, batchUnitId }))} /><UnitSelect label="Section" value={form.sectionUnitId} units={unitsByKind('SECTION')} onChange={(sectionUnitId) => setForm((value) => ({ ...value, sectionUnitId }))} /><label><span>Academic start date</span><input type="date" value={form.academicStartDate} onChange={(event) => setForm((value) => ({ ...value, academicStartDate: event.target.value }))} /></label><label><span>Expected graduation date</span><input type="date" value={form.expectedGraduationDate} onChange={(event) => setForm((value) => ({ ...value, expectedGraduationDate: event.target.value }))} /></label><button type="submit">Add student</button></form>
    <section className="role-card role-wide"><h2>Import Students</h2>{csvError ? <p className="form-error" role="alert">{csvError}</p> : null}<p>CSV validates academic unit names, stores resolved institution unit IDs, and rejects unknown/cross-institution names.</p><textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={5} /><div className="role-record-actions"><button type="button" onClick={() => void previewImport()}>Validate CSV</button>{preview ? <button type="button" disabled={preview.rejectedCount > 0} onClick={() => void commitImport()}>Commit {preview.acceptedCount} rows</button> : null}</div>{preview ? <div><p>{preview.acceptedCount} accepted, {preview.warningCount} warnings, {preview.rejectedCount} rejected.</p><table className="role-record-table"><thead><tr><th>Row</th><th>Email</th><th>State</th><th>Resolved units</th><th>Issues</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.email}</td><td>{row.state}</td><td>{[row.departmentUnitId, row.programUnitId, row.batchUnitId, row.sectionUnitId].filter(Boolean).length} IDs</td><td>{row.issues.join(', ') || 'None'}</td></tr>)}</tbody></table></div> : null}</section>
    <section className="role-card role-wide"><h2>Search students</h2><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, or institution ID" /></section>
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} real students</caption><thead><tr><th>Student</th><th>Institution ID</th><th>Units</th><th>Relationship</th><th>Invitation</th><th>Actions</th></tr></thead><tbody>{filteredStudents.map((student) => <tr key={student.id} className="role-record-row"><th scope="row"><strong>{student.fullName}</strong><span>{student.email}</span></th><td>{student.institutionStudentId}</td><td>{Object.values(student.units ?? {}).filter(Boolean).length} assigned</td><td>{student.relationship?.state ?? student.status}</td><td>{student.status}</td><td><div className="role-record-actions"><button type="button" className="secondary" onClick={() => void editStudent(student)}>Edit student</button><button type="button" onClick={() => void relationship(student.id, 'TRANSFERRED')}>Transfer</button><button type="button" onClick={() => void relationship(student.id, 'GRADUATED')}>Graduate</button><button type="button" className="secondary" onClick={() => void relationship(student.id, 'ENDED')}>End relationship</button><button type="button" className="secondary" onClick={() => void relationship(student.id, 'REVOKED')}>Revoke</button></div></td></tr>)}</tbody></table></div>
  </section>;
}

function InstitutionAcademicStructurePage({ portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [form, setForm] = useState({ kind: 'DEPARTMENT', name: '', parentUnitId: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (token && institutionId) void listInstitutionUnits(token, institutionId).then((result) => setUnits(result.units)).catch(() => setError('Unable to load academic units.')); }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Academic Structure" message="Sign in with an Institution Admin identity to manage academic structure." />;
  if (authenticatedWorkspace && !institutionWorkspaceRoles.has(authenticatedWorkspace.role)) return <InstitutionWorkspaceError title="Academic Structure" unauthorized />;
  if (!isInstitutionWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Academic Structure" />;
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await createInstitutionUnit(token!, institutionId, { kind: form.kind, name: form.name, ...(form.parentUnitId ? { parentUnitId: form.parentUnitId } : {}) });
      setForm({ kind: 'DEPARTMENT', name: '', parentUnitId: '' });
      setNotice('Academic unit created.');
    } catch {
      setError('Academic unit creation failed. Check parent scope and duplicate/invalid data.');
    }
  }
  async function edit(unit: InstitutionUnitDto): Promise<void> {
    const name = window.prompt('Unit name', unit.name);
    if (!name || name.trim() === unit.name) return;
    setError('');
    try {
      await updateInstitutionUnit(token!, institutionId, unit.id, { name: name.trim() });
      setNotice('Academic unit updated.');
    } catch {
      setError('Academic unit update failed.');
    }
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Academic Structure</h1><p>Manage institution-scoped departments, programs, batches, sections and campuses. Parent choices are institution-scoped.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🏛️" tone="blue" value={units.filter((unit) => unit.kind === 'DEPARTMENT').length} label="Departments" />
      <V2Stat icon="🎓" tone="purple" value={units.filter((unit) => unit.kind === 'PROGRAM').length} label="Programs" />
      <V2Stat icon="📅" tone="green" value={units.filter((unit) => unit.kind === 'BATCH').length} label="Batches" />
      <V2Stat icon="🧩" tone="amber" value={units.filter((unit) => ['SECTION', 'CAMPUS'].includes(unit.kind)).length} label="Sections and campuses" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<form className="role-card role-wide role-management-form" onSubmit={(event) => void create(event)}><h2>Add academic unit</h2><label><span>Kind</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value }))}><option>DEPARTMENT</option><option>PROGRAM</option><option>BATCH</option><option>SECTION</option><option>CAMPUS</option></select></label><label><span>Name</span><input value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} required /></label><UnitSelect label="Parent unit" value={form.parentUnitId} units={units} onChange={(parentUnitId) => setForm((value) => ({ ...value, parentUnitId }))} /><button type="submit">Create unit</button></form><div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} academic units</caption><thead><tr><th>Name</th><th>Kind</th><th>Parent</th><th>Action</th></tr></thead><tbody>{units.map((unit) => <tr key={unit.id}><th>{unit.name}</th><td>{unit.kind}</td><td>{units.find((candidate) => candidate.id === unit.parentUnitId)?.name ?? 'Institution'}</td><td><button type="button" className="secondary" onClick={() => void edit(unit)}>Edit unit</button></td></tr>)}</tbody></table></div></section>;
}

function InstitutionStaffPage({ portal: _portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [staff, setStaff] = useState<InstitutionStaffDto | null>(null);
  const [form, setForm] = useState({ email: '', role: 'FACULTY_LECTURER' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    listInstitutionStaff(token, institutionId, controller.signal).then((result) => setStaff(result.staff)).catch((error: unknown) => setError(formatApiError(error, 'Unable to load staff assignments.')));
    return () => controller.abort();
  }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Staff" message="Sign in with an Institution Admin identity to invite institution staff." />;
  if (authenticatedWorkspace && !institutionWorkspaceRoles.has(authenticatedWorkspace.role)) return <InstitutionWorkspaceError title="Staff" unauthorized />;
  if (!isInstitutionWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Staff" />;
  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await inviteInstitutionStaff(token!, institutionId, form.email, form.role);
      setNotice('Staff invitation created. Membership is created only after the verified recipient accepts.');
      setForm({ email: '', role: 'FACULTY_LECTURER' });
    } catch (error) {
      setError(formatApiError(error, 'Staff invitation failed.'));
    }
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Staff</h1><p>Invite institution staff through the verified-recipient invitation lifecycle. This screen does not attach arbitrary global user IDs.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="teal" value={staff?.memberships.length ?? 0} label="Active memberships" />
      <V2Stat icon="✉️" tone="amber" value={staff?.invitations.filter((invite) => invite.state === 'PENDING').length ?? 0} label="Pending invitations" />
      <V2Stat icon="📮" tone="blue" value={staff?.invitations.length ?? 0} label="Invitations sent" />
      <V2Stat icon="🔐" tone="purple" value="Verified" label="Recipient-verified onboarding" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void invite(event)}>
      <h2>Invite institution staff</h2>
      <label><span>Recipient email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label>
      <label><span>Institution role *</span><select value={form.role} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value }))}><option value="FACULTY_LECTURER">Faculty Lecturer</option><option value="DEPARTMENT_HEAD">Department Head</option><option value="PLACEMENT_ADMIN">Placement Admin</option></select></label>
      <button type="submit">Send staff invitation</button>
    </form>
    <section className="role-card role-wide"><h2>Staff onboarding boundary</h2><ul className="role-check-list"><li>Allowed roles: PLACEMENT_ADMIN, DEPARTMENT_HEAD, FACULTY_LECTURER.</li><li>No platform, employer or self-escalation role is exposed.</li><li>The recipient must authenticate with a verified matching email before membership is created.</li></ul></section>
    <section className="role-card role-wide"><h2>Staff invitations</h2>{staff?.invitations.length ? <table className="role-record-table"><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Delivery</th><th>Expires</th></tr></thead><tbody>{staff.invitations.map((invite) => <tr key={invite.id}><td>{invite.email}</td><td>{invite.role}</td><td>{invite.state}</td><td>{invite.delivery?.state ?? 'Pending command'}</td><td>{new Date(invite.expiresAt).toLocaleDateString()}</td></tr>)}</tbody></table> : <p>No staff invitations yet.</p>}</section>
    <section className="role-card role-wide"><h2>Active staff memberships</h2>{staff?.memberships.length ? <table className="role-record-table"><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Actions</th></tr></thead><tbody>{staff.memberships.map((member) => <tr key={member.id}><td>{member.email}</td><td>{member.role}</td><td>{member.state}</td><td><span className="staff-readonly-note">Revoke/resend/end membership: NOT YET AVAILABLE</span></td></tr>)}</tbody></table> : <p>No accepted staff memberships yet.</p>}</section>
  </section>;
}

function EmployerRecruiterRealityPage({ portal, routeLabel }: { readonly portal: RolePortalConfig; readonly routeLabel: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [employerMembership, setEmployerMembership] = useState<{ readonly organizationId: string; readonly role: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getSecurityContext(token, controller.signal).then((context) => {
      const membership = context.memberships.find((item) => ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(item.role));
      if (membership) setEmployerMembership({ organizationId: membership.organizationId, role: membership.role });
      else setError('This identity has no active employer-scoped membership.');
    }).catch(() => setError('Unable to resolve employer context.'));
    return () => controller.abort();
  }, [token]);
  if (!token) return <RestrictedApiState title="Sign in to manage hiring" message="Sign in with an employer identity to see your opportunities and applicants. Preview role switching is not authentication." />;
  if (error) return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>{routeLabel}</h1><p role="alert" className="form-error">{error}</p></div></div></section>;
  if (!employerMembership) return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>{routeLabel}</h1><p role="status">Loading your employer workspace…</p></div></div></section>;

  const employerId = employerMembership.organizationId;
  if (/opportunit/i.test(routeLabel)) {
    return <StaffPilotWrap title="Opportunities" subtitle="Post roles, choose their audience and publish. Applications land under Applicants.">
      <EmployerOpportunitiesPage employerId={employerId} /></StaffPilotWrap>;
  }
  if (/applicant|candidate|talent/i.test(routeLabel)) {
    return <StaffPilotWrap title="Applicants" subtitle="Move real candidates through your process; every change is logged.">
      <EmployerApplicantsPage employerId={employerId} /></StaffPilotWrap>;
  }

  // Routes whose backend does not exist yet keep saying so rather than borrowing
  // another page's data.
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Coming later</span>
      <h1>{routeLabel}</h1>
      <p>Opportunities and Applicants carry your live pipeline today.</p>
    </div></div>
    <div className="role-wide"><V2EmptyState icon="🧭" title="Not built yet"
      note={`${routeLabel} is on the roadmap but has no live workflow behind it yet - nothing here is hidden or broken.`}
      hint="Interviews and offers are managed from the applicant row on the Applicants page." /></div>
  </section>;
}

function OperationsUsersAccessPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<readonly OperationsUserAccessDto[]>([]);
  const [invitations, setInvitations] = useState<readonly OperationsInvitationDto[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    Promise.all([
      listOperationsUsersAccess(token, query, controller.signal),
      listOperationsInvitations(token, query, controller.signal),
    ]).then(([userResult, invitationResult]) => {
      setUsers(userResult.users);
      setInvitations(invitationResult.invitations);
    }).catch(() => setError('Unable to load Operations governance data.'));
    return () => controller.abort();
  }, [token, query]);
  if (!token) return <RestrictedApiState title="Users & Access" message="Sign in with an Operations identity to inspect users and access." />;
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">READ_ONLY governance</span><h1>Users & Access</h1><p>Search users, identity links, memberships and Student relationship counts. No tokens, password data, raw invitation tokens or platform-role mutation are exposed.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="teal" value={users.length} label="Accounts shown" />
      <V2Stat icon="🎓" tone="blue" value={users.filter((user) => user.studentRelationshipCount > 0).length} label="Student accounts" />
      <V2Stat icon="🏛️" tone="purple" value={users.filter((user) => user.memberships.length > 0).length} label="With organization roles" />
      <V2Stat icon="✉️" tone="amber" value={invitations.filter((invitation) => invitation.state === 'PENDING').length} label="Pending invitations" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}<section className="role-card role-wide"><label className="role-local-search"><span>Search by email or internal user ID</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="person@example.test or UUID" /></label></section><section className="role-card role-wide"><h2>Users</h2><table className="role-record-table"><thead><tr><th>Email</th><th>User ID</th><th>Identity link</th><th>Memberships</th><th>Student relationships</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td>{user.email}</td><td>{user.id}</td><td>{user.identityLinkStatus}</td><td>{user.memberships.map((item) => `${String(item.role)} / ${String(item.state)}`).join(', ') || 'None'}</td><td>{user.studentRelationshipCount}</td></tr>)}</tbody></table></section><section className="role-card role-wide"><h2>Invitation tracking</h2><InvitationInventoryTable invitations={invitations} /></section></section>;
}

function OperationsContentReadOnlyPage(): React.ReactElement {
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">READ_ONLY content operations</span><h1>Content Operations</h1><p>Career Readiness governance state and automation status are shown from protected Operations APIs. Content authoring is NOT YET AVAILABLE.</p></div></div><OperationsCareerReadinessPanel /><section className="role-card role-wide"><h2>Authoring boundary</h2><p>CMS-style editing, review submission and publication mutations are intentionally not simulated in Phase 2A.</p></section></section>;
}

function OperationsTechnicalReadOnlyPage({ routeLabel }: { readonly routeLabel: string }): React.ReactElement {
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">READ_ONLY technical operations</span><h1>{routeLabel}</h1><p>Safe operational status only: API health is visible in the shell, and outbox/workflow/automation status is loaded through the existing Operations status endpoint. Secrets and n8n credentials are never displayed.</p></div></div><OperationsCareerReadinessPanel /><section className="role-card role-wide"><h2>Mutation boundary</h2><p>n8n remains inactive unless explicitly enabled outside this UI. Kill-switch, workflow activation and credential operations are not exposed as Phase 2A buttons.</p></section></section>;
}

function AuthenticatedReadOnlyModule({ title, detail }: { readonly title: string; readonly detail: string }): React.ReactElement {
  return <section className="role-module"><div className="role-page-heading"><div><span className="eyebrow">Read-only</span><h1>{title}</h1><p>{detail}</p></div></div>
    <div className="role-wide"><V2EmptyState icon="🔎" title="View-only for your role"
      note="You can see authorized context here, but changes for this module are not switched on yet for your role."
      hint="Assessments and Help & FAQ are fully live — use the sidebar to reach them." /></div></section>;
}

function AuthenticatedNotYetAvailable({ title, detail }: { readonly title: string; readonly detail: string }): React.ReactElement {
  return <section className="role-module"><div className="role-page-heading"><div><span className="eyebrow">Coming later</span><h1>{title}</h1><p>{detail}</p></div></div>
    <div className="role-wide"><V2EmptyState icon="🧭" title="Not built yet"
      note="This module is on the roadmap but has no live workflow behind it yet — nothing here is hidden or broken."
      hint="Your dashboard shows everything that is live for your role today." /></div></section>;
}

function RestrictedApiState({ title, message }: { readonly title: string; readonly message: string }): React.ReactElement {
  return <section className="role-module"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>{title}</h1><p>{message}</p></div></div>
    <div className="role-wide"><V2EmptyState icon="🔐" title="Sign-in required"
      note="This protected workflow only renders for an authorized identity — no preview or fake data is substituted." /></div></section>;
}

function UnitSelect({ label, value, units, onChange }: { readonly label: string; readonly value: string; readonly units: readonly InstitutionUnitDto[]; readonly onChange: (value: string) => void }): React.ReactElement {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">None</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.kind}: {unit.name}</option>)}</select></label>;
}

function cleanStudentPayload(form: Record<string, string>): InstitutionStudentCreateRequest {
  const payload: {
    institutionStudentId: string;
    fullName: string;
    email: string;
    departmentUnitId?: string;
    programUnitId?: string;
    batchUnitId?: string;
    sectionUnitId?: string;
    academicStartDate?: string;
    expectedGraduationDate?: string;
  } = {
    institutionStudentId: (form.institutionStudentId ?? '').trim(),
    fullName: (form.fullName ?? '').trim(),
    email: (form.email ?? '').trim(),
  };
  if (form.departmentUnitId?.trim()) payload.departmentUnitId = form.departmentUnitId.trim();
  if (form.programUnitId?.trim()) payload.programUnitId = form.programUnitId.trim();
  if (form.batchUnitId?.trim()) payload.batchUnitId = form.batchUnitId.trim();
  if (form.sectionUnitId?.trim()) payload.sectionUnitId = form.sectionUnitId.trim();
  if (form.academicStartDate?.trim()) payload.academicStartDate = form.academicStartDate.trim();
  if (form.expectedGraduationDate?.trim()) payload.expectedGraduationDate = form.expectedGraduationDate.trim();
  return payload;
}

function formatApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  const message = safeErrorMessage(error.code) ?? fallback;
  return `${message}${error.field ? ` Field: ${error.field}.` : ''} Reference: ${error.correlationId}`;
}

function safeErrorMessage(code: string | undefined): string | undefined {
  switch (code) {
    case 'STUDENT_EMAIL_ALREADY_EXISTS': return 'This email is already associated with a ONE identity and cannot be attached automatically. Use the approved onboarding/recovery workflow.';
    case 'INSTITUTION_STUDENT_ID_ALREADY_EXISTS': return 'A Student with this institution ID already exists.';
    case 'INVALID_ACADEMIC_DATE_WINDOW': return 'Expected graduation date must be on or after academic start date.';
    case 'INVALID_ACADEMIC_UNIT_SCOPE': return 'Selected academic unit is not valid for this Institution and field.';
    case 'STAFF_INVITATION_ALREADY_PENDING': return 'Staff invitation already pending.';
    case 'FORBIDDEN': return 'You do not have permission to perform this action.';
    default: return undefined;
  }
}

function InvitationInventoryTable({ invitations }: { readonly invitations: readonly OperationsInvitationDto[] }): React.ReactElement {
  if (!invitations.length) return <p>No invitations match the current search.</p>;
  return <table className="role-record-table"><thead><tr><th>Recipient</th><th>Organization</th><th>Role</th><th>State</th><th>Delivery</th><th>Expires</th></tr></thead><tbody>{invitations.map((invite) => <tr key={invite.id}><td>{invite.recipientEmail}</td><td>{invite.organization?.legalName ?? 'No organization'}</td><td>{invite.role}</td><td>{invite.state}</td><td>{invite.delivery?.state ?? 'No command'}</td><td>{new Date(invite.expiresAt).toLocaleDateString()}</td></tr>)}</tbody></table>;
}


function DetailDialog({ portal, record, openerRef, onClose }: { readonly portal: RolePortalConfig; readonly record: RoleFixture; readonly openerRef: React.RefObject<HTMLElement | null>; readonly onClose: () => void }): React.ReactElement {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef);
  const close = (): void => {
    onClose();
    openerRef.current?.focus();
  };
  useEscape(close);
  return <div className="role-modal-backdrop" role="presentation"><section ref={dialogRef} className="role-modal" role="dialog" aria-modal="true" aria-labelledby="role-detail-title"><h2 id="role-detail-title">{record.title}</h2><p>{record.detail}</p><dl><div><dt>Role</dt><dd>{portal.roleName}</dd></div><div><dt>Owner</dt><dd>{record.owner}</dd></div><div><dt>Status</dt><dd>{record.status}</dd></div><div><dt>Protected boundary</dt><dd>{record.protectedNote}</dd></div></dl><div className="role-modal-actions"><button type="button" className="secondary" onClick={close}>Close</button></div></section></div>;
}

function EditDialog({ portal, record, route, openerRef, onClose }: { readonly portal: RolePortalConfig; readonly record: RoleFixture; readonly route: RoleNavItem; readonly openerRef: React.RefObject<HTMLElement | null>; readonly onClose: () => void }): React.ReactElement {
  const [status, setStatus] = useState(record.status);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const { saveRecord } = useRolePreviewState();
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef);
  const close = (): void => {
    onClose();
    openerRef.current?.focus();
  };
  useEscape(close);
  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (!status.trim() || !note.trim()) {
      setError('Status and preview note are required.');
      return;
    }
    saveRecord(portal.key, record, note.trim(), status.trim(), primaryAction(portal, route));
    close();
  }
  return <div className="role-modal-backdrop" role="presentation"><section ref={dialogRef} className="role-modal" role="dialog" aria-modal="true" aria-labelledby="role-edit-title"><h2 id="role-edit-title">{primaryAction(portal, route)}</h2><p>{record.protectedNote}</p><form onSubmit={submit} noValidate><label><span>Status</span><input value={status} onChange={(event) => setStatus(event.target.value)} required /></label><label><span>Preview note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Record a session-local preview note" required /></label>{error ? <p role="alert" className="form-error">{error}</p> : null}<div className="role-modal-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button type="submit">Save preview change</button></div></form></section></div>;
}

function useDialogFocus(dialogRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    first?.focus();
  }, [dialogRef]);
}

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function resolveRoute(portal: RolePortalConfig, path: string): RoleNavItem | undefined {
  const normalized = normalize(path);
  return portal.nav.find((item) => item.path === normalized) ?? portal.nav[0];
}

function normalize(path: string): string {
  return path.replace(/\/$/, '');
}

function primaryAction(portal: RolePortalConfig, route: RoleNavItem): string {
  if (/assessment/i.test(route.label)) return portal.roleName.includes('Student') ? 'Start assessment' : 'Create draft assessment';
  if (/interview|schedule|calendar|session|meeting/i.test(route.label)) return 'Schedule preview session';
  if (/offer/i.test(route.label)) return portal.family === 'Employer' ? 'Draft offer' : 'Review offer';
  if (/report|analysis|dashboard|visual|export/i.test(route.label)) return 'Generate preview report';
  if (/message|communication|note/i.test(route.label)) return 'Add preview note';
  if (/candidate|student|applicant/i.test(route.label)) return portal.family === 'Employer' ? 'Update candidate stage' : 'Assign support task';
  if (/organization|verification|trust|support|feature|health/i.test(route.label)) return 'Update preview queue status';
  return portal.allowedOperations[0] ?? 'Save preview change';
}

function moduleDescription(portal: RolePortalConfig, route: RoleNavItem): string {
  return `${route.label} for ${portal.previewUser} at ${portal.organization}. This page exposes ${portal.roleName}-appropriate records, filters, detail review and owned preview actions.`;
}

function isDenseManagementRoute(portal: RolePortalConfig, route: RoleNavItem): boolean {
  if (portal.key === 'operations-admin') {
    return /organizations|users|verification|trust and safety|audit logs|security|system health/i.test(route.label);
  }
  if (portal.family === 'Institution') return /students|cohort/i.test(route.label);
  if (portal.family === 'Employer') return /applicants|candidate|pipeline/i.test(route.label);
  return false;
}
