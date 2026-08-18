import { Bell, ChevronDown, Filter, Menu, MessageSquare, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiHealth } from './api.js';
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

export function RolePortal({ portal, apiHealth, showDevelopmentIndicators, onNavigate }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly showDevelopmentIndicators: boolean; readonly onNavigate: (path: string) => void }): React.ReactElement {
  return <RolePreviewProvider><RolePortalInner portal={portal} apiHealth={apiHealth} showDevelopmentIndicators={showDevelopmentIndicators} onNavigate={onNavigate} /></RolePreviewProvider>;
}

function RolePortalInner({ portal, apiHealth, showDevelopmentIndicators, onNavigate }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly showDevelopmentIndicators: boolean; readonly onNavigate: (path: string) => void }): React.ReactElement {
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
        <RoleTopbar portal={portal} apiHealth={apiHealth} showDevelopmentIndicators={showDevelopmentIndicators} menuButtonRef={menuButtonRef} onOpenMenu={() => setDrawerOpen(true)} onMessages={() => { const messagesRoute = portal.nav.find((item) => /messages|communications/i.test(item.label)); if (messagesRoute) navigate(messagesRoute.path); else setTopbarNotice(`${portal.roleName} messaging is backend-dependent and no message route exists for this preview role.`); }} onNotifications={() => setTopbarNotice(`${portal.roleName} notifications preview: 4 local demo alerts are summarized only; no backend notification state was changed.`)} onSwitch={() => navigate('/demo')} />
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

function RoleTopbar({ portal, apiHealth, showDevelopmentIndicators, menuButtonRef, onOpenMenu, onMessages, onNotifications, onSwitch }: { readonly portal: RolePortalConfig; readonly apiHealth: ApiHealth; readonly showDevelopmentIndicators: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly onOpenMenu: () => void; readonly onMessages: () => void; readonly onNotifications: () => void; readonly onSwitch: () => void }): React.ReactElement {
  return <header className="role-topbar"><button ref={menuButtonRef} className="icon-button mobile-menu-button" type="button" aria-label={`Open ${portal.roleName} navigation`} onClick={onOpenMenu}><Menu size={20} /></button><span className="role-context">{portal.roleName}</span><span className="role-org">{portal.organization}</span><label className="role-search" role="search"><Search size={16} /><span className="sr-only">Search {portal.roleName} workspace</span><input placeholder={`Search ${portal.family.toLowerCase()} records...`} /></label><div className="role-topbar-actions"><button type="button" className="secondary" onClick={onSwitch}>Switch preview portal</button><button className="icon-button" type="button" aria-label="Messages" onClick={onMessages}><MessageSquare size={17} /></button><button className="icon-button notification" type="button" aria-label="Notifications" onClick={onNotifications}><Bell size={17} /><span>4</span></button>{showDevelopmentIndicators ? <span className={`staff-api-dot ${apiHealth}`}>{apiHealth}</span> : null}<span className="role-profile"><span>{portal.initials}</span><span><strong>{portal.previewUser}</strong><small>{portal.roleName}</small></span><ChevronDown size={14} /></span></div></header>;
}

function PreviewNotice({ portal, notice }: { readonly portal: RolePortalConfig; readonly notice: string }): React.ReactElement {
  const { dirty, reset } = useRolePreviewState();
  return <section className="role-preview-notice" role="note"><span><strong>{dirty ? 'Unsaved session changes' : 'Portal preview'}</strong> — role selection here does not authenticate or authorize a user. {portal.enforcementStatus}.</span>{notice ? <span role="status">{notice}</span> : null}{dirty ? <button type="button" className="secondary" onClick={reset}>Reset demo data</button> : null}</section>;
}

function RoleDashboard({ portal, onNavigate }: { readonly portal: RolePortalConfig; readonly onNavigate: (path: string) => void }): React.ReactElement {
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
  const categories = [...new Set(portal.records.map((record) => record.category))];
  const records = portal.records.filter((record) => {
    const filterMatch = filters.length === 0 || filters.includes(record.category) || filters.includes(record.status);
    const textMatch = `${record.title} ${record.owner} ${record.status} ${record.category} ${record.detail}`.toLowerCase().includes(query.toLowerCase());
    return filterMatch && textMatch;
  });

  return (
    <section className="role-module">
      {portal.key === 'operations-admin' && /content management|system health|audit logs|security/i.test(route.label)
        ? <OperationsCareerReadinessPanel /> : null}
      <div className="role-page-heading"><div><span className="eyebrow">{portal.roleName}</span><h1>{route.label}</h1><p>{moduleDescription(portal, route)} Preview data only; backend authorization remains authoritative.</p></div><button type="button" onClick={(event) => { openerRef.current = event.currentTarget; setEditing(portal.records[0]!); }}>{primaryAction(portal, route)}</button></div>
      <div className="role-card role-filters"><label className="role-local-search"><span>Search {route.label}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${route.label.toLowerCase()}...`} /></label><div className="filter-row" aria-label={`${route.label} filters`}>{categories.map((category) => <button key={category} type="button" aria-pressed={filters.includes(category)} className={filters.includes(category) ? 'selected' : ''} onClick={() => setFilters((value) => value.includes(category) ? value.filter((item) => item !== category) : [...value, category])}><Filter size={14} />{category}</button>)}{filters.length ? <button type="button" className="secondary" onClick={() => setFilters([])}>Clear filters</button> : null}</div><p className="result-count" role="status">{records.length} records shown</p></div>
      {records.length ? <RoleRecordList portal={portal} records={records} onDetail={(record, opener) => { openerRef.current = opener; setDetail(record); }} onEdit={(record, opener) => { openerRef.current = opener; setEditing(record); }} /> : <section className="role-empty"><h2>No records match these filters</h2><p>Clear filters or search text to restore the preview records.</p><button type="button" onClick={() => { setQuery(''); setFilters([]); }}>Clear filters</button></section>}
      <section className="role-card role-wide"><h2>Ownership boundaries</h2><div className="role-boundary-grid"><div><strong>Allowed in preview</strong><ul>{portal.allowedOperations.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>Read-only</strong><ul>{portal.readOnlyData.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>Forbidden</strong><ul>{portal.forbiddenOperations.map((item) => <li key={item}>{item}</li>)}</ul></div></div></section>
      {detail ? <DetailDialog portal={portal} record={detail} openerRef={openerRef} onClose={() => setDetail(null)} /> : null}
      {editing ? <EditDialog portal={portal} record={editing} route={route} openerRef={openerRef} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function RoleRecordList({ portal, records, primaryRecord, onDetail, onEdit }: { readonly portal: RolePortalConfig; readonly records: readonly RoleFixture[]; readonly primaryRecord?: RoleFixture; readonly onDetail?: (record: RoleFixture, opener: HTMLElement) => void; readonly onEdit?: (record: RoleFixture, opener: HTMLElement) => void }): React.ReactElement {
  const { openDetail } = useRolePreviewState();
  return <div className="role-record-grid">{records.map((record) => <article className="role-record-card" key={record.id} data-primary={primaryRecord?.id === record.id || undefined}><div><span>{record.category}</span><h3>{record.title}</h3><p>{record.detail}</p></div><dl><div><dt>Owner</dt><dd>{record.owner}</dd></div><div><dt>Status</dt><dd><StatusBadge label={record.status} tone="info" /></dd></div></dl><p className="staff-readonly-note">{record.protectedNote}</p><div className="role-record-actions"><button type="button" onClick={(event) => { openDetail(portal.key, record); onDetail?.(record, event.currentTarget); }}>View detail</button><button type="button" className="secondary" onClick={(event) => onEdit?.(record, event.currentTarget)}>Edit preview</button></div></article>)}</div>;
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
