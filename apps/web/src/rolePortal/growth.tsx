/**
 * ONE · Role portal — the Growth workspace (GROWTH-01, ADR-040).
 *
 * The Home page (re-skin phase 7: rolePortal/growthHome.tsx, the approved Momentum composition)
 * and the other approved navigation items (HG-3, 2026-09-30). A page whose source is not built yet
 * says so plainly. No lead, visit, target or amount is invented, in any state.
 *
 * GROWTH-06: Field is built (growthField.tsx); Home's "Visits this month" and the follow-ups-due
 * card come from the field log.
 *
 * GROWTH-07: Commission shows the person's credit and disputes (growthCommission.tsx); no amount
 * is shown, because no rate has been set.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getGrowthTerritory, getProtectedAccessToken, type GrowthTerritoryDto } from '../api.js';
import { V2Chip, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import type { RoleNavItem } from '../rolePortalConfig.js';
import { GrowthLeadsPage } from './growthLeads.js';
import { GrowthFieldPage } from './growthField.js';
import { GrowthCommissionPage } from './growthCommission.js';
import { GrowthHome } from './growthHome.js';
import { AuthenticatedNotYetAvailable } from './shared.js';
import { SupportCode } from '../supportCode.js';
import { formatDate } from '../dates.js';

const roleLabels: Readonly<Record<string, string>> = { GROWTH_EXECUTIVE: 'Growth executive', GROWTH_MANAGER: 'Regional manager' };

/** What each page will hold once built, said plainly (design §16.1). */
const notBuilt: Readonly<Record<string, string>> = {
  Targets: 'Targets is not built yet. When it is, your targets for the month and quarter, and progress counted from real records, will be here.',
  Team: 'Team is not built yet. When it is, your team members, their workload and stale leads will be here.',
};

/**
 * The Growth Home. Re-skin phase 7 moved it to the approved Momentum composition in
 * rolePortal/growthHome.tsx, which leaves out every block with no source instead of printing a placeholder.
 * This name stays so the portal's route table does not change.
 */
export function GrowthHomePage(): React.ReactElement {
  return <GrowthHome />;
}

export function GrowthModulePage({ route, role }: { readonly route: RoleNavItem; readonly role?: string | undefined }): React.ReactElement {
  // A page limited to some roles (Team, for managers) is not shown to anyone else, even by URL.
  if (route.roles && (role === undefined || !route.roles.includes(role))) {
    return <V2EmptyState illustration="no-access" icon="🔐" title={`${route.label} is for regional managers`} note="This page is not part of your role. Your access has not changed." />;
  }
  if (route.label === 'Territory') return <GrowthTerritoryPage />;
  if (route.label === 'Leads') return <GrowthLeadsPage role={role} />;
  if (route.label === 'Field') return <GrowthFieldPage role={role} />;
  if (route.label === 'Commission') return <GrowthCommissionPage />;
  return <AuthenticatedNotYetAvailable title={route.label} detail={notBuilt[route.label] ?? `${route.label} is not built yet.`} />;
}

type TerritoryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly territory: GrowthTerritoryDto }
  | { readonly kind: 'forbidden' | 'error'; readonly reference: string | null };

function areaLabel(area: { readonly stateName: string; readonly districtName: string | null }): string {
  return area.districtName ? `${area.districtName}, ${area.stateName}` : `${area.stateName} (whole state)`;
}

/**
 * GROWTH-02: Growth → Territory. The regions the person works today (set by operations), each with
 * the states or districts it covers and the people in it: a manager sees everyone assigned to their
 * regions; an executive sees the region's managers. GROWTH-03: each region carries its count of open,
 * unowned, contactable leads.
 */
export function GrowthTerritoryPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<TerritoryState>({ kind: 'loading' });
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    getGrowthTerritory(token, controller.signal)
      .then((territory) => setState({ kind: 'ready', territory }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const reference = cause instanceof ApiRequestError ? cause.correlationId : null;
        setState({ kind: cause instanceof ApiRequestError && cause.status === 403 ? 'forbidden' : 'error', reference });
      });
    return () => controller.abort();
  }, [token]);

  if (state.kind === 'forbidden') {
    return <V2EmptyState illustration="no-access" icon="🔐" title="Not permitted" note="Territory is for AI8HT's partnerships staff. Your access has not changed."
      {...(state.reference ? { hint: <SupportCode reference={state.reference} /> } : {})} />;
  }
  const territory = state.kind === 'ready' ? state.territory : null;
  const regions = territory?.regions ?? [];
  const areaCount = regions.reduce((total, region) => total + region.areas.length, 0);
  const peopleCount = new Set(regions.flatMap((region) => region.people.map((person) => person.email))).size;
  const managing = regions.some((region) => region.myRole === 'MANAGER');

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">ONE · Growth · Territory</p>
            <h1>Your territory</h1>
            <p>{state.kind === 'loading' ? 'Loading your regions…'
              : state.kind === 'error' ? 'Your territory could not be loaded. Try again shortly.'
                : regions.length ? 'The regions you work today, as set by AI8HT operations. A change by operations shows here at once.'
                  : 'You are not assigned to a region yet. Operations assigns regions in Settings → Growth set-up.'}</p>
            <div className="v2-hero-chips">
              {territory ? <V2Chip tone="blue">{roleLabels[territory.role] ?? territory.role}</V2Chip> : null}
              <V2Chip tone="slate">Set by operations</V2Chip>
            </div>
          </div>
        </div>

        <div className="v2-row v2-cols-4" role="region" aria-label="Territory summary">
          <V2Stat icon="🗺️" tone="blue" value={territory ? regions.length : null} label="Regions you work" />
          <V2Stat icon="📍" tone="teal" value={territory ? areaCount : null} label="Areas covered" />
          <V2Stat icon="👥" tone="amber" value={territory ? peopleCount : null} label={managing ? 'People in your regions' : 'Managers in your regions'} />
          <V2Stat icon="🤝" tone="purple" value={territory && regions.every((region) => typeof region.unownedLeads === 'number') ? regions.reduce((total, region) => total + (region.unownedLeads ?? 0), 0) : null} label="Unowned leads" />
        </div>

        {state.kind === 'loading' ? <section className="v2-card"><p className="v2-empty">Loading…</p></section> : null}
        {state.kind === 'error' ? <section className="v2-card"><p className="v2-empty">Your territory could not be loaded.</p></section> : null}
        {territory && !regions.length ? <V2EmptyState illustration="no-leads" icon="🗺️" title="No region assigned" note="You see your own leads anywhere; unowned leads appear once operations assigns you a region." /> : null}
        {regions.map((region) => (
          <section key={region.id} className="v2-card" aria-label={`Region ${region.name}`}>
            <div className="v2-card-head"><h2>{region.name}</h2>
              <V2Chip tone={region.myRole === 'MANAGER' ? 'purple' : 'teal'}>{region.myRole === 'MANAGER' ? 'You manage this region' : 'You work this region'}</V2Chip>
              {typeof region.unownedLeads === 'number' ? <V2Chip tone="amber">{`${region.unownedLeads} unowned lead${region.unownedLeads === 1 ? '' : 's'}`}</V2Chip> : null}</div>
            {region.since ? <p className="v2-empty">Since {formatDate(region.since)}</p> : null}
            <div className="v2-hero-chips" aria-label={`Areas of ${region.name}`}>
              {region.areas.length ? region.areas.map((area) => <V2Chip key={`${area.stateCode}-${area.districtCode ?? 'all'}`} tone="slate">{areaLabel(area)}</V2Chip>)
                : <span className="v2-empty">No areas yet — operations has not added any state or district to this region.</span>}
            </div>
            <div className="v2-list">
              {region.people.length ? region.people.map((person) => (
                <div key={`${person.email}-${person.role}`} className="v2-list-row">
                  <span className="v2-tile teal" aria-hidden="true">{person.role === 'MANAGER' ? '🧭' : '🧑‍💼'}</span>
                  <div className="grow"><strong>{person.email}</strong><small>{person.role === 'MANAGER' ? 'Regional manager' : 'Growth executive'}</small></div>
                </div>
              )) : <p className="v2-empty">{region.myRole === 'MANAGER' ? 'Nobody else is assigned to this region.' : 'No manager is assigned to this region yet.'}</p>}
            </div>
          </section>
        ))}
      </div>

      <div className="v2-rail">
        <section className="v2-card">
          <div className="v2-card-head"><h2>How territory works</h2></div>
          <p className="v2-empty">You always see the leads you own, wherever they are. Unowned leads are shown to the people working the region that covers them{managing ? ', and you see every lead in the regions you manage' : ''}. When operations moves you off a region, its unowned leads leave your view at once.</p>
        </section>
        <section className="v2-card">
          <div className="v2-card-head"><h2>Unowned leads</h2></div>
          <p className="v2-empty">Each region shows how many open leads in it have no owner and may be contacted. Claim them from Leads → Unowned in my regions.</p>
        </section>
      </div>
    </div>
  );
}
