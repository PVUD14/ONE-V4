import { Bell, CalendarDays, ChevronsLeft, Filter, Menu, MessageSquare, MoreVertical, Search, X } from 'lucide-react';
import { BrandWordmark } from './brand.js';
import { useEffect, useRef, useState, useId, type ReactNode } from 'react';
import type { AuthStatus } from './auth.js';
import { AuthControls } from './authControls.js';
import type { ApiHealth } from './api.js';
import { dashboardFilters, dateRanges, riskFilters, staffNavGroups, staffNavItems } from './staffConfig.js';
import { placementIdentity, type StaffKpi } from './staffData.js';

export function StaffShell({ apiHealth, authStatus, authNotice, showDevelopmentIndicators, activePath, onNavigate, onSignIn, onSignOut, children }: { readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly activePath: string; readonly onNavigate: (path: string) => void; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly children: ReactNode }): React.ReactElement {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [topbarNotice, setTopbarNotice] = useState('');
  const menuButtonRef = useRef<HTMLButtonElement>(null);

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

  function closeDrawer(): void {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }

  return (
    <div className={`staff-shell ${collapsed ? 'staff-sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#staff-main">Skip to content</a>
      <StaffSidebar activePath={activePath} collapsed={collapsed} drawerOpen={drawerOpen} onNavigate={(path) => { onNavigate(path); setDrawerOpen(false); }} onCollapse={() => setCollapsed((value) => !value)} onClose={closeDrawer} />
      {drawerOpen ? <button className="drawer-scrim staff-scrim" type="button" aria-label="Close institution navigation" onClick={closeDrawer} /> : null}
      <div className="staff-workspace">
        <StaffTopBar apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} showDevelopmentIndicators={showDevelopmentIndicators} menuButtonRef={menuButtonRef} onOpenMenu={() => setDrawerOpen(true)} onNavigate={onNavigate} onNotifications={() => setTopbarNotice('Placement notifications preview: 5 local demo alerts are summarized only; no backend notification state was changed.')} activePath={activePath} onSignIn={onSignIn} onSignOut={onSignOut} />
        <main id="staff-main" className="staff-main">{topbarNotice ? <section className="staff-preview-notice" role="status">{topbarNotice}</section> : null}{children}</main>
      </div>
    </div>
  );
}

function StaffSidebar({ activePath, collapsed, drawerOpen, onNavigate, onCollapse, onClose }: { readonly activePath: string; readonly collapsed: boolean; readonly drawerOpen: boolean; readonly onNavigate: (path: string) => void; readonly onCollapse: () => void; readonly onClose: () => void }): React.ReactElement {
  return (
    <aside className={`staff-sidebar ${drawerOpen ? 'drawer-open' : ''}`} aria-label="Institution placement navigation">
      <div className="staff-brand"><BrandWordmark height={26} /><span className="staff-brand-copy"><strong>ONE</strong><small>Institution Portal</small></span><button className="icon-button sidebar-close" type="button" aria-label="Close institution navigation" onClick={onClose} autoFocus={drawerOpen}><X size={18} /></button></div>
      <nav className="staff-nav" aria-label="Grouped Institution placement navigation">
        {staffNavGroups.map((group) => <div className="staff-nav-group" key={group}><span>{group}</span>{staffNavItems.filter((item) => item.group === group).map((item) => { const Icon = item.icon; const active = activePath === item.path; return <button key={item.path} type="button" className={`staff-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item.path)}><Icon size={16} aria-hidden="true" /><span>{item.label}</span></button>; })}</div>)}
      </nav>
      <button className="staff-collapse" type="button" onClick={onCollapse} aria-label={collapsed ? 'Expand institution sidebar' : 'Collapse institution sidebar'}><ChevronsLeft size={16} /><span>{collapsed ? 'Expand' : 'Collapse'}</span></button>
    </aside>
  );
}

function StaffTopBar({ apiHealth, authStatus, authNotice, showDevelopmentIndicators, menuButtonRef, onOpenMenu, onNavigate, onNotifications, activePath, onSignIn, onSignOut }: { readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly showDevelopmentIndicators: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly onOpenMenu: () => void; readonly onNavigate: (path: string) => void; readonly onNotifications: () => void; readonly activePath: string; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  return (
    <header className="staff-topbar">
      <button ref={menuButtonRef} className="icon-button mobile-menu-button" type="button" aria-label="Open institution navigation" onClick={onOpenMenu}><Menu size={20} /></button>
      <span className="staff-context-select" aria-label="Active staff role">{placementIdentity.role}</span>
      <span className="staff-college-select" aria-label="Active institution">{placementIdentity.organization}</span>
      <label className="staff-search" role="search"><Search size={16} aria-hidden="true" /><span className="sr-only">Search institution placement workspace</span><input placeholder="Search students, assessments, opportunities..." /></label>
      <div className="staff-topbar-actions"><button className="icon-button" type="button" aria-label="Calendar" onClick={() => onNavigate('/institution/placement-officer/events')} disabled={activePath === '/institution/placement-officer/events'}><CalendarDays size={17} /></button><button className="icon-button notification" type="button" aria-label="Notifications" onClick={onNotifications}><Bell size={17} /><span>5</span></button><button className="icon-button" type="button" aria-label="Messages" onClick={() => onNavigate('/institution/placement-officer/communications')} disabled={activePath === '/institution/placement-officer/communications'}><MessageSquare size={17} /></button><AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />{showDevelopmentIndicators ? <span className={`staff-api-dot ${apiHealth}`}>{apiHealth === 'online' ? 'API Online' : apiHealth === 'offline' ? 'API Offline' : 'Checking'}</span> : null}<span className="staff-profile" aria-label="Placement Officer identity"><span>{placementIdentity.initials}</span><span><strong>{placementIdentity.previewUser}</strong><small>{placementIdentity.role}</small></span></span></div>
    </header>
  );
}

export function StaffPageHeader({ dateRange, department, risk, onDateRange, onDepartment, onRisk }: { readonly dateRange: string; readonly department: string; readonly risk: string; readonly onDateRange: (value: string) => void; readonly onDepartment: (value: string) => void; readonly onRisk: (value: string) => void }): React.ReactElement {
  const panelId = useId();
  const [filtersOpen, setFiltersOpen] = useState(() => window.location.hash === '#filters-open');

  return (
    <section className="staff-page-header">
      <div><span className="staff-eyebrow">{placementIdentity.organization}</span><h1>Placement Dashboard</h1><p>Operational overview of placement activity, student readiness, risk, and interventions. Preview data only; authorization is still backend-enforced.</p></div>
      <div className="staff-filter-row" aria-label="Dashboard filters">
        <label><span>Date range</span><select value={dateRange} onChange={(event) => onDateRange(event.target.value)}>{dateRanges.map((item) => <option key={item}>{item}</option>)}</select></label>
        <button type="button" className="staff-filter-button" aria-expanded={filtersOpen} aria-controls={panelId} onClick={() => setFiltersOpen((value) => !value)}><Filter size={15} />Filters</button>
        <div id={panelId} className={`staff-filter-panel ${filtersOpen ? 'open' : ''}`}>
          <label><span>Department</span><select value={department} onChange={(event) => onDepartment(event.target.value)}>{dashboardFilters.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Readiness</span><select value={risk} onChange={(event) => onRisk(event.target.value)}>{riskFilters.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
      </div>
    </section>
  );
}

export function StaffPreviewBadge({ apiHealth }: { readonly apiHealth: ApiHealth }): React.ReactElement {
  return <div className="staff-preview-badge" aria-label="Institution preview mode"><span>UI preview</span><span>{apiHealth}</span></div>;
}

export function StaffKpiCard({ item }: { readonly item: StaffKpi }): React.ReactElement {
  const Icon = item.icon;
  return <article className={`staff-card staff-kpi ${item.tone}`}><span className="staff-kpi-icon"><Icon size={19} /></span><div><span>{item.label}</span><strong>{item.value}</strong><small>{item.detail}</small></div></article>;
}

export function StaffSection({ title, action, onAction, className = '', id, children }: { readonly title: string; readonly action?: string; readonly onAction?: () => void; readonly className?: string; readonly id?: string; readonly children: ReactNode }): React.ReactElement {
  return <section id={id} className={`staff-card ${className}`}><div className="staff-section-title"><h2>{title}</h2>{action ? <button type="button" onClick={onAction}>{action}</button> : null}</div>{children}</section>;
}

export function MiniActionButton({ label, onClick, disabled = false }: { readonly label: string; readonly onClick?: () => void; readonly disabled?: boolean }): React.ReactElement {
  return <button type="button" className="staff-mini-action" aria-label={`${label} preview action`} onClick={onClick} disabled={disabled}>{label}</button>;
}

export function MoreButton({ label, onClick }: { readonly label: string; readonly onClick?: () => void }): React.ReactElement {
  return <button type="button" className="staff-icon-action" aria-label={label} onClick={onClick}><MoreVertical size={15} /></button>;
}
