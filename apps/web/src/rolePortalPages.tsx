import { Bell, ChevronDown, Filter, Menu, MessageSquare, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthStatus } from './auth.js';
import { AuthControls } from './authControls.js';
import {
  addInstitutionStudent,
  commitStudentRosterImport,
  createInstitutionUnit,
  createOperationsOrganization,
  endInstitutionStudentRelationship,
  getProtectedAccessToken,
  getSecurityContext,
  inviteInstitutionStaff,
  inviteInitialOrganizationAdmin,
  listInstitutionStudents,
  listInstitutionUnits,
  listOperationsOrganizations,
  previewStudentRosterImport,
  transitionOrganizationVerification,
  updateInstitutionStudent,
  updateOperationsOrganization,
  type ApiHealth,
  type InstitutionStudentDto,
  type InstitutionUnitDto,
  type OrganizationManagementDto,
  type RosterImportPreviewDto,
} from './api.js';
import { portalFamilyIcons, rolePortals, type RoleFixture, type RoleNavItem, type RolePortalConfig } from './rolePortalConfig.js';
import { RolePreviewProvider, useRolePreviewState } from './rolePortalPreviewState.js';
import { StatusBadge } from './studentComponents.js';
import { OperationsCareerReadinessPanel } from './operationsCareerReadinessPanel.js';

export function DemoPortalLauncher({ onNavigate }: { readonly onNavigate: (path: string) => void }): React.ReactElement {
  const groups = ['Student', 'Institution', 'Employer', 'Operations'] as const;
  useEffect(() => {
    document.title = 'Portal Preview Launcher | PlanThePath';
  }, []);
  return (
    <main className="demo-launcher">
      <section className="demo-hero">
        <span className="eyebrow">PlanThePath product preview</span>
        <h1>Multi-role portal launcher</h1>
        <p>Portal preview - role selection here does not authenticate or authorize a user.</p>
      </section>
      {groups.map((family) => {
        const Icon = portalFamilyIcons[family];
        return <section className="demo-family" key={family}><div className="demo-family-title"><Icon size={20} /><h2>{family}</h2></div><div className="demo-role-grid">{rolePortals.filter((portal) => portal.family === family).map((portal) => <article className={`demo-role-card role-accent-${portal.accent}`} key={portal.key}><span>{portal.subtitle}</span><h3>{portal.roleName}</h3><p>{portal.organization}</p><dl><div><dt>Preview user</dt><dd>{portal.previewUser}</dd></div><div><dt>Backend role</dt><dd>{portal.backendRole}</dd></div><div><dt>Enforcement</dt><dd>{portal.enforcementStatus}</dd></div></dl><button type="button" onClick={() => onNavigate(portal.basePath)}>Open portal</button></article>)}</div></section>;
      })}
    </main>
  );
}

export function RolePortal({ portal, apiHealth, authStatus, authNotice, showDevelopmentIndicators, onNavigate, onSignIn, onSignOut }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly onNavigate: (path: string) => void; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  return <RolePreviewProvider><RolePortalInner portal={portal} apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} showDevelopmentIndicators={showDevelopmentIndicators} onNavigate={onNavigate} onSignIn={onSignIn} onSignOut={onSignOut} /></RolePreviewProvider>;
}

function RolePortalInner({ portal, apiHealth, authStatus, authNotice, showDevelopmentIndicators, onNavigate, onSignIn, onSignOut }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly onNavigate: (path: string) => void; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  const [path, setPath] = useState(normalize(window.location.pathname));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [topbarNotice, setTopbarNotice] = useState('');
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const activeRoute = resolveRoute(portal, path);

  useEffect(() => {
    const label = activeRoute?.label ?? (portal.nav[0]?.label ?? 'Dashboard');
    document.title = label === 'Dashboard' || label === 'Overview' ? `${portal.dashboardTitle} | PlanThePath` : `${label} - ${portal.roleName} | PlanThePath`;
  }, [activeRoute, portal]);

  useEffect(() => {
    const onPop = (): void => setPath(normalize(window.location.pathname));
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
    window.history.pushState(null, '', nextPath);
    setPath(normalize(nextPath));
    setDrawerOpen(false);
    onNavigate(nextPath);
  }

  return (
    <div className={`role-shell role-accent-${portal.accent} ${collapsed ? 'role-sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#role-main">Skip to content</a>
      <RoleSidebar portal={portal} activePath={path} collapsed={collapsed} drawerOpen={drawerOpen} onNavigate={navigate} onCollapse={() => setCollapsed((value) => !value)} onClose={() => { setDrawerOpen(false); menuButtonRef.current?.focus(); }} />
      {drawerOpen ? <button className="drawer-scrim role-scrim" type="button" aria-label={`Close ${portal.roleName} navigation`} onClick={() => setDrawerOpen(false)} /> : null}
      <div className="role-workspace">
        <RoleTopbar portal={portal} apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} showDevelopmentIndicators={showDevelopmentIndicators} menuButtonRef={menuButtonRef} onOpenMenu={() => setDrawerOpen(true)} onMessages={() => { const messagesRoute = portal.nav.find((item) => /messages|communications/i.test(item.label)); if (messagesRoute) navigate(messagesRoute.path); else setTopbarNotice(`${portal.roleName} messaging is backend-dependent and no message route exists for this preview role.`); }} onNotifications={() => setTopbarNotice(`${portal.roleName} notifications preview: 4 local demo alerts are summarized only; no backend notification state was changed.`)} onSwitch={() => navigate('/demo')} onSignIn={onSignIn} onSignOut={onSignOut} />
        <main id="role-main" className="role-main">
          <PreviewNotice portal={portal} notice={topbarNotice} />
          {activeRoute?.path === portal.basePath ? <RoleDashboard portal={portal} onNavigate={navigate} /> : <RoleModulePage portal={portal} route={activeRoute ?? portal.nav[0]!} />}
        </main>
      </div>
    </div>
  );
}

function RoleSidebar({ portal, activePath, collapsed, drawerOpen, onNavigate, onCollapse, onClose }: { readonly portal: RolePortalConfig; readonly activePath: string; readonly collapsed: boolean; readonly drawerOpen: boolean; readonly onNavigate: (path: string) => void; readonly onCollapse: () => void; readonly onClose: () => void }): React.ReactElement {
  const groups = [...new Set(portal.nav.map((item) => item.group))];
  return (
    <aside className={`role-sidebar ${drawerOpen ? 'drawer-open' : ''}`} aria-label={`${portal.roleName} navigation`}>
      <div className="role-brand"><span className="role-brand-mark">{portal.initials}</span><span><strong>PlanThePath</strong><small>{portal.subtitle}</small></span><button className="icon-button sidebar-close" type="button" aria-label={`Close ${portal.roleName} navigation`} onClick={onClose} autoFocus={drawerOpen}><X size={18} /></button></div>
      <nav className="role-nav" aria-label={`Grouped ${portal.roleName} navigation`}>
        {groups.map((group) => <div className="role-nav-group" key={group}><span>{group}</span>{portal.nav.filter((item) => item.group === group).map((item) => { const Icon = item.icon; const active = activePath === item.path; return <button key={item.path} type="button" className={`role-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item.path)}><Icon size={16} aria-hidden="true" /><span>{item.label}</span></button>; })}</div>)}
      </nav>
      <button className="role-collapse" type="button" onClick={onCollapse}>{collapsed ? 'Expand' : 'Collapse'}</button>
    </aside>
  );
}

function RoleTopbar({ portal, apiHealth, authStatus, authNotice, showDevelopmentIndicators, menuButtonRef, onOpenMenu, onMessages, onNotifications, onSwitch, onSignIn, onSignOut }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly onOpenMenu: () => void; readonly onMessages: () => void; readonly onNotifications: () => void; readonly onSwitch: () => void; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  return <header className="role-topbar"><button ref={menuButtonRef} className="icon-button mobile-menu-button" type="button" aria-label={`Open ${portal.roleName} navigation`} onClick={onOpenMenu}><Menu size={20} /></button><span className="role-context">{portal.roleName}</span><span className="role-org">{portal.organization}</span><label className="role-search" role="search"><Search size={16} /><span className="sr-only">Search {portal.roleName} workspace</span><input placeholder={`Search ${portal.family.toLowerCase()} records...`} /></label><div className="role-topbar-actions"><button type="button" className="secondary" onClick={onSwitch}>Switch preview portal</button><button className="icon-button" type="button" aria-label="Messages" onClick={onMessages}><MessageSquare size={17} /></button><button className="icon-button notification" type="button" aria-label="Notifications" onClick={onNotifications}><Bell size={17} /><span>4</span></button><AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />{showDevelopmentIndicators ? <span className={`staff-api-dot ${apiHealth}`}>{apiHealth}</span> : null}<span className="role-profile"><span>{portal.initials}</span><span><strong>{portal.previewUser}</strong><small>{portal.roleName}</small></span><ChevronDown size={14} /></span></div></header>;
}

function PreviewNotice({ portal, notice }: { readonly portal: RolePortalConfig; readonly notice: string }): React.ReactElement {
  const { dirty, reset } = useRolePreviewState();
  return <section className="role-preview-notice" role="note"><span><strong>{dirty ? 'Unsaved session changes' : 'Portal preview'}</strong> — role selection here does not authenticate or authorize a user. {portal.enforcementStatus}.</span>{notice ? <span role="status">{notice}</span> : null}{dirty ? <button type="button" className="secondary" onClick={reset}>Reset demo data</button> : null}</section>;
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

function RoleModulePage({ portal, route }: { readonly portal: RolePortalConfig; readonly route: RoleNavItem }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<readonly string[]>([]);
  const [detail, setDetail] = useState<RoleFixture | null>(null);
  const [editing, setEditing] = useState<RoleFixture | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const dense = isDenseManagementRoute(portal, route);
  if (portal.key === 'operations-admin' && route.label === 'Organizations') return <OperationsOrganizationsPage portal={portal} />;
  if (portal.key === 'institution-admin' && route.label === 'Students') return <InstitutionStudentsPage portal={portal} />;
  if (portal.key === 'institution-admin' && route.label === 'Academic Structure') return <InstitutionAcademicStructurePage portal={portal} />;
  if (portal.key === 'institution-admin' && route.label === 'Staff') return <InstitutionStaffPage portal={portal} />;
  if (portal.key === 'recruiter') return <EmployerRecruiterRealityPage portal={portal} routeLabel={route.label} />;
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
  const [form, setForm] = useState({ kind: 'INSTITUTION', legalName: '', displayName: '', countryCode: 'IN', city: '', adminEmail: '' });
  const load = useMemo(() => async (signal?: AbortSignal) => {
    if (!token) return;
    const result = await listOperationsOrganizations(token, signal);
    setOrganizations(result.organizations);
  }, [token]);
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
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void create(event)}><h2>Add Organization</h2><label><span>Type *</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value }))}><option value="INSTITUTION">Institution</option><option value="EMPLOYER">Employer</option></select></label><label><span>Legal Name *</span><input value={form.legalName} onChange={(event) => setForm((value) => ({ ...value, legalName: event.target.value }))} required /></label><label><span>Display Name</span><input value={form.displayName} onChange={(event) => setForm((value) => ({ ...value, displayName: event.target.value }))} /></label><label><span>Country *</span><input value={form.countryCode} onChange={(event) => setForm((value) => ({ ...value, countryCode: event.target.value.toUpperCase() }))} maxLength={2} required /></label><label><span>City</span><input value={form.city} onChange={(event) => setForm((value) => ({ ...value, city: event.target.value }))} /></label><label><span>Primary Admin Email</span><input type="email" value={form.adminEmail} onChange={(event) => setForm((value) => ({ ...value, adminEmail: event.target.value }))} /></label><button type="submit">Create organization</button></form>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} real organizations</caption><thead><tr><th>Organization</th><th>Kind</th><th>Location</th><th>Verification</th><th>Initial Admin</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{organizations.map((org) => <tr key={org.id} className="role-record-row"><th scope="row"><strong>{org.profile.displayName || org.legalName}</strong><span>{org.legalName}</span></th><td>{org.kind}</td><td>{[org.profile.city, org.profile.countryCode].filter(Boolean).join(', ') || 'Not set'}</td><td><StatusBadge label={org.verificationState} tone="info" /></td><td>{org.initialAdminInvitation?.email ?? 'Not invited'}</td><td>{new Date(org.updatedAt).toLocaleDateString()}</td><td><div className="role-record-actions"><button type="button" className="secondary" onClick={() => void edit(org)}>Edit details</button>{org.verificationState === 'PENDING' ? <button type="button" onClick={() => void transition(org.id, 'UNDER_REVIEW')}>Begin review</button> : null}{org.verificationState === 'UNDER_REVIEW' ? <><button type="button" onClick={() => void transition(org.id, 'VERIFIED')}>Verify</button><button type="button" className="secondary" onClick={() => void transition(org.id, 'REJECTED')}>Reject</button></> : null}{org.verificationState === 'VERIFIED' ? <button type="button" className="secondary" onClick={() => void transition(org.id, 'SUSPENDED')}>Suspend</button> : null}<button type="button" className="secondary" onClick={() => void invite(org.id)}>Invite admin</button></div></td></tr>)}</tbody></table></div>
    <section className="role-card role-wide"><h2>Operations boundary</h2><p>Student add/import/transfer controls are intentionally absent from Operations. Those workflows belong to Institution Administration.</p></section>
  </section>;
}

function InstitutionStudentsPage({ portal }: { readonly portal: RolePortalConfig }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [institutionId, setInstitutionId] = useState('');
  const [students, setStudents] = useState<readonly InstitutionStudentDto[]>([]);
  const [preview, setPreview] = useState<RosterImportPreviewDto | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ fullName: '', institutionStudentId: '', email: '' });
  const [csv, setCsv] = useState('institution_student_id,full_name,email,department,program,batch,section\n');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getSecurityContext(token, controller.signal).then((context) => {
      const membership = context.memberships.find((item) => ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'].includes(item.role));
      if (membership) setInstitutionId(membership.organizationId);
    }).catch(() => setError('Unable to resolve institution context.'));
    return () => controller.abort();
  }, [token]);
  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    listInstitutionStudents(token, institutionId, controller.signal).then((result) => setStudents(result.students)).catch(() => setError('Unable to load institution students.'));
    return () => controller.abort();
  }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Students" message="Sign in with an Institution Admin identity to manage students." />;
  async function addStudent(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await addInstitutionStudent(token!, institutionId, { institutionStudentId: form.institutionStudentId, fullName: form.fullName, email: form.email });
      setForm({ fullName: '', institutionStudentId: '', email: '' });
      setNotice('Student added with institution relationship; global identity was not hard-deleted or bypassed.');
    } catch {
      setError('Add student failed. Check authorization and duplicate IDs.');
    }
  }
  async function editStudent(student: InstitutionStudentDto): Promise<void> {
    const fullName = window.prompt('Student full name', student.fullName);
    if (!fullName || fullName.trim() === student.fullName) return;
    setError('');
    try {
      await updateInstitutionStudent(token!, institutionId, student.id, { fullName: fullName.trim() });
      setNotice('Student institution data updated.');
    } catch {
      setError('Student update failed. Check authorization and institution scope.');
    }
  }
  async function relationship(studentId: string, state: string): Promise<void> {
    setError('');
    try {
      await endInstitutionStudentRelationship(token!, institutionId, studentId, state);
      setNotice(`Student relationship marked ${state}.`);
    } catch {
      setError('Relationship update failed. Check current relationship state and institution scope.');
    }
  }
  async function previewImport(): Promise<void> {
    try {
      const result = await previewStudentRosterImport(token!, institutionId, 'uat-roster.csv', csv);
      setPreview(result.import);
    } catch {
      setError('CSV preview failed validation.');
    }
  }
  async function commitImport(): Promise<void> {
    if (!preview) return;
    await commitStudentRosterImport(token!, institutionId, preview.id);
    setNotice('Roster import committed.');
    setPreview(null);
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Students</h1><p>Institution-owned roster and relationship lifecycle. This is not an Operations workflow.</p></div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void addStudent(event)}><h2>Add Student</h2><label><span>Full name *</span><input value={form.fullName} onChange={(event) => setForm((value) => ({ ...value, fullName: event.target.value }))} required /></label><label><span>Institution ID *</span><input value={form.institutionStudentId} onChange={(event) => setForm((value) => ({ ...value, institutionStudentId: event.target.value }))} required /></label><label><span>Email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label><button type="submit" disabled={!institutionId}>Add student</button></form>
    <section className="role-card role-wide"><h2>Import Students</h2><textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={5} /><div className="role-record-actions"><button type="button" onClick={() => void previewImport()}>Validate CSV</button>{preview ? <button type="button" onClick={() => void commitImport()}>Commit {preview.acceptedCount} rows</button> : null}</div>{preview ? <p>{preview.acceptedCount} accepted, {preview.warningCount} warnings, {preview.rejectedCount} rejected.</p> : null}</section>
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} real students</caption><thead><tr><th>Student</th><th>Institution ID</th><th>Relationship</th><th>Invitation</th><th>Actions</th></tr></thead><tbody>{students.map((student) => <tr key={student.id} className="role-record-row"><th scope="row"><strong>{student.fullName}</strong><span>{student.email}</span></th><td>{student.institutionStudentId}</td><td>{student.relationship?.state ?? student.status}</td><td>{student.status}</td><td><div className="role-record-actions"><button type="button" className="secondary" onClick={() => void editStudent(student)}>Edit student</button><button type="button" onClick={() => void relationship(student.id, 'TRANSFERRED')}>Transfer</button><button type="button" onClick={() => void relationship(student.id, 'GRADUATED')}>Graduate</button><button type="button" className="secondary" onClick={() => void relationship(student.id, 'ENDED')}>End relationship</button></div></td></tr>)}</tbody></table></div>
  </section>;
}

function InstitutionAcademicStructurePage({ portal }: { readonly portal: RolePortalConfig }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [institutionId, setInstitutionId] = useState('');
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [form, setForm] = useState({ kind: 'DEPARTMENT', name: '' });
  useEffect(() => { if (token) void getSecurityContext(token).then((context) => setInstitutionId(context.memberships.find((item) => ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'].includes(item.role))?.organizationId ?? '')); }, [token]);
  useEffect(() => { if (token && institutionId) void listInstitutionUnits(token, institutionId).then((result) => setUnits(result.units)); }, [token, institutionId, form.name]);
  if (!token) return <RestrictedApiState title="Academic Structure" message="Sign in with an Institution Admin identity to manage academic structure." />;
  async function create(event: React.FormEvent): Promise<void> { event.preventDefault(); await createInstitutionUnit(token!, institutionId, form); setForm({ kind: 'DEPARTMENT', name: '' }); }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Academic Structure</h1><p>Manage institution-scoped departments, programs, batches and sections.</p></div></div><form className="role-card role-wide role-management-form" onSubmit={(event) => void create(event)}><h2>Add academic unit</h2><label><span>Kind</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value }))}><option>DEPARTMENT</option><option>PROGRAM</option><option>BATCH</option><option>SECTION</option></select></label><label><span>Name</span><input value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} required /></label><button type="submit" disabled={!institutionId}>Create unit</button></form><div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} academic units</caption><thead><tr><th>Name</th><th>Kind</th><th>Parent</th></tr></thead><tbody>{units.map((unit) => <tr key={unit.id}><th>{unit.name}</th><td>{unit.kind}</td><td>{unit.parentUnitId ?? 'Institution'}</td></tr>)}</tbody></table></div></section>;
}

function InstitutionStaffPage({ portal: _portal }: { readonly portal: RolePortalConfig }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [institutionId, setInstitutionId] = useState('');
  const [form, setForm] = useState({ email: '', role: 'FACULTY_LECTURER' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getSecurityContext(token, controller.signal).then((context) => {
      const membership = context.memberships.find((item) => ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'].includes(item.role));
      if (membership) setInstitutionId(membership.organizationId);
    }).catch(() => setError('Unable to resolve institution context.'));
    return () => controller.abort();
  }, [token]);
  if (!token) return <RestrictedApiState title="Staff" message="Sign in with an Institution Admin identity to invite institution staff." />;
  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await inviteInstitutionStaff(token!, institutionId, form.email, form.role);
      setNotice('Staff invitation created. Membership is created only after the verified recipient accepts.');
      setForm({ email: '', role: 'FACULTY_LECTURER' });
    } catch {
      setError('Staff invitation failed. Platform roles, self-escalation and cross-institution requests are rejected.');
    }
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Staff</h1><p>Invite institution staff through the verified-recipient invitation lifecycle. This screen does not attach arbitrary global user IDs.</p></div></div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void invite(event)}>
      <h2>Invite institution staff</h2>
      <label><span>Recipient email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label>
      <label><span>Institution role *</span><select value={form.role} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value }))}><option value="FACULTY_LECTURER">Faculty Lecturer</option><option value="DEPARTMENT_HEAD">Department Head</option><option value="PLACEMENT_ADMIN">Placement Admin</option></select></label>
      <button type="submit" disabled={!institutionId}>Send staff invitation</button>
    </form>
    <section className="role-card role-wide"><h2>Staff onboarding boundary</h2><ul className="role-check-list"><li>Allowed roles: PLACEMENT_ADMIN, DEPARTMENT_HEAD, FACULTY_LECTURER.</li><li>No platform, employer or self-escalation role is exposed.</li><li>The recipient must authenticate with a verified matching email before membership is created.</li></ul></section>
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
  if (!token) return <RestrictedApiState title="Employer hiring flow partially implemented" message="Sign in with Maya UAT Recruiter to view the real employer scope. Preview role switching is not authentication." />;
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed / PARTIAL</span><h1>Employer hiring flow partially implemented</h1><p>{routeLabel} for {portal.roleName}. The backend currently enforces employer membership plus applicant grants, but opportunity, application, interview and offer persistence are not implemented in this product slice.</p></div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-kpi-grid" aria-label="Employer implementation status"><article className="role-card role-kpi"><span>Employer identity</span><strong>{employerMembership ? 'Resolved' : 'Checking'}</strong><p>{employerMembership ? `${employerMembership.role} at ${employerMembership.organizationId}` : 'Loaded from protected security context'}</p></article><article className="role-card role-kpi"><span>Applicant access</span><strong>Scoped grants</strong><p>Only explicit active employer applicant grants are readable.</p></article><article className="role-card role-kpi"><span>Hiring workflow</span><strong>PARTIAL</strong><p>No real opportunities/applications/interviews table yet.</p></article></section>
    <section className="role-card role-wide"><h2>What is real now</h2><ul className="role-check-list"><li>Authenticated employer identity and active recruiter membership are resolved from the backend.</li><li>Applicant access is enforced by `employer_applicant_access_grants` and denies expired, revoked, unrelated or cross-employer access.</li><li>No Student Readiness score or generic student directory is exposed to employers.</li></ul></section>
    <section className="role-card role-wide"><h2>Smallest next vertical slice</h2><p>To make Employer hiring PASS instead of PARTIAL, add employer-owned opportunity persistence, student-consented applications, and a list endpoint that returns only applicants with active grants for that employer and opportunity. Until then, this page intentionally avoids fake candidate tables.</p></section>
  </section>;
}

function RestrictedApiState({ title, message }: { readonly title: string; readonly message: string }): React.ReactElement {
  return <section className="role-module"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>{title}</h1><p>{message}</p></div></div><section className="role-empty"><h2>Restricted</h2><p>No fake mutation or preview role selection is used for this protected workflow.</p></section></section>;
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
