/**
 * ONE · Role portal — the Growth workspace (GROWTH-01, ADR-040).
 *
 * The Home page in the pilot's composition (greeting hero, stat tiles, cards) and the other
 * approved navigation items (HG-3, 2026-09-30). In GROWTH-01 the only real facts are the
 * person's own role, teams, manager and staff type (`GET /api/v1/growth/me`). Every figure
 * whose source is not built yet shows NA in its slot, and every other page says plainly that
 * it is not built yet. No lead, visit, target or amount is invented, in any state.
 *
 * GROWTH-06: Field is built (growthField.tsx); Home's "Visits this month" and the follow-ups-due
 * card come from the field log.
 *
 * GROWTH-07: Commission shows the person's credit and disputes (growthCommission.tsx); every amount
 * still reads NA.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getGrowthMe, getGrowthTerritory, getProtectedAccessToken, type GrowthMeDto, type GrowthTerritoryDto } from '../api.js';
import { V2Chip, V2EmptyState, V2Ring, V2Stat } from '../dashboardsV2.js';
import type { RoleNavItem } from '../rolePortalConfig.js';
import { GrowthLeadsPage } from './growthLeads.js';
import { GrowthFieldPage } from './growthField.js';
import { GrowthCommissionPage } from './growthCommission.js';
import { AuthenticatedNotYetAvailable } from './shared.js';

const NA = 'NA';

const teamLabels: Readonly<Record<string, string>> = {
  COLLEGE_PARTNERSHIPS: 'College partnerships',
  EMPLOYER_PARTNERSHIPS: 'Employer partnerships',
};
const staffTypeLabels: Readonly<Record<string, string>> = { EMPLOYEE: 'Employee', CONTRACTOR: 'Contractor' };
const roleLabels: Readonly<Record<string, string>> = { GROWTH_EXECUTIVE: 'Growth executive', GROWTH_MANAGER: 'Regional manager' };

/** What each page will hold once built, said plainly (design §16.1). */
const notBuilt: Readonly<Record<string, string>> = {
  Targets: 'Targets is not built yet. When it is, your targets for the month and quarter, and progress counted from real records, will be here.',
  Team: 'Team is not built yet. When it is, your team members, their workload and stale leads will be here.',
};

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

type MeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly me: GrowthMeDto }
  | { readonly kind: 'forbidden' | 'error'; readonly reference: string | null };

export function GrowthHomePage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<MeState>({ kind: 'loading' });
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    getGrowthMe(token, controller.signal)
      .then((me) => setState({ kind: 'ready', me }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const reference = cause instanceof ApiRequestError ? cause.correlationId : null;
        setState({ kind: cause instanceof ApiRequestError && cause.status === 403 ? 'forbidden' : 'error', reference });
      });
    return () => controller.abort();
  }, [token]);

  if (state.kind === 'forbidden') {
    return <V2EmptyState icon="🔐" title="Not permitted" note="The Growth workspace is for AI8HT's partnerships staff. Your access has not changed."
      {...(state.reference ? { hint: `Reference: ${state.reference}` } : {})} />;
  }
  const me = state.kind === 'ready' ? state.me : null;
  const teams = me?.teams ?? [];

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">ONE · Growth workspace</p>
            <h1>{greeting()} 👋</h1>
            <p>{state.kind === 'loading' ? 'Loading your growth details…'
              : state.kind === 'error' ? 'Your growth details could not be loaded. Try again shortly.'
                : 'Your partnerships workspace. Pages fill in as each part of the Growth portal is built.'}</p>
            <div className="v2-hero-chips">
              <V2Chip tone="blue">{me ? roleLabels[me.role] ?? me.role : NA}</V2Chip>
              <V2Chip tone="slate">{me?.staffType ? staffTypeLabels[me.staffType] ?? me.staffType : 'Staff type not set'}</V2Chip>
            </div>
          </div>
          <V2Ring percent={0} value={NA} label="TARGET PROGRESS" tone="#0f766e" />
        </div>

        <div className="v2-row v2-cols-4" role="region" aria-label="Growth summary">
          <V2Stat icon="🤝" tone="blue" value={typeof me?.openLeads === 'number' ? me.openLeads : NA} label="Open leads" />
          <V2Stat icon="📍" tone="teal" value={typeof me?.visitsThisMonth === 'number' ? me.visitsThisMonth : NA} label="Visits this month" />
          <V2Stat icon="🎯" tone="amber" value={NA} label="Target progress" />
          <V2Stat icon="₹" tone="purple" value={NA} label="Commission this month" />
        </div>

        <section className="v2-card" aria-label="Your teams">
          <div className="v2-card-head"><h2>Your teams</h2><V2Chip tone="slate">Set by operations</V2Chip></div>
          {state.kind === 'loading' ? <p className="v2-empty">Loading…</p>
            : state.kind === 'error' ? <p className="v2-empty">{NA} — your teams could not be loaded.</p>
              : teams.length ? (
                <div className="v2-list">
                  {teams.map((team) => (
                    <div key={team.team} className="v2-list-row">
                      <span className="v2-tile teal" aria-hidden="true">{team.team === 'COLLEGE_PARTNERSHIPS' ? '🏛️' : '🏢'}</span>
                      <div className="grow"><strong>{teamLabels[team.team] ?? team.team}</strong>
                        <small>{team.manager ? `Manager: ${team.manager.email}` : 'No manager recorded'}</small></div>
                      <V2Chip tone="green">Since {new Date(team.joinedAt).toLocaleDateString()}</V2Chip>
                    </div>
                  ))}
                </div>
              ) : <p className="v2-empty">You are not on a team yet. Operations sets your team in Settings.</p>}
        </section>
      </div>

      <div className="v2-rail">
        <section className="v2-card" aria-label="Follow-ups due">
          <div className="v2-card-head"><h2>Follow-ups due</h2><V2Chip tone="amber">Today or earlier</V2Chip></div>
          <p className="v2-empty">{typeof me?.followUpsDue === 'number'
            ? (me.followUpsDue ? `${me.followUpsDue} follow-up${me.followUpsDue === 1 ? ' is' : 's are'} due today or overdue. Open Field to work through them.` : 'Nothing is due today. New follow-ups appear in Field.')
            : `${NA} — follow-ups could not be counted.`}</p>
        </section>
        <section className="v2-card">
          <div className="v2-card-head"><h2>Coming next</h2><V2Chip tone="slate">Not built yet</V2Chip></div>
          <p className="v2-empty">Targets and commission amounts are not built yet. Commission shows what is credited to you; every figure above reads NA until it has a real source.</p>
        </section>
        <section className="v2-card">
          <div className="v2-card-head"><h2>Protected boundaries</h2></div>
          <p className="v2-empty">Growth never sees a student&apos;s name, record, readiness or application, cannot verify or approve an organisation, and cannot set a rate or record a payment.</p>
        </section>
      </div>
    </div>
  );
}

export function GrowthModulePage({ route, role }: { readonly route: RoleNavItem; readonly role?: string | undefined }): React.ReactElement {
  // A page limited to some roles (Team, for managers) is not shown to anyone else, even by URL.
  if (route.roles && (role === undefined || !route.roles.includes(role))) {
    return <V2EmptyState icon="🔐" title={`${route.label} is for regional managers`} note="This page is not part of your role. Your access has not changed." />;
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
    return <V2EmptyState icon="🔐" title="Not permitted" note="Territory is for AI8HT's partnerships staff. Your access has not changed."
      {...(state.reference ? { hint: `Reference: ${state.reference}` } : {})} />;
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
              <V2Chip tone="blue">{territory ? roleLabels[territory.role] ?? territory.role : NA}</V2Chip>
              <V2Chip tone="slate">Set by operations</V2Chip>
            </div>
          </div>
        </div>

        <div className="v2-row v2-cols-4" role="region" aria-label="Territory summary">
          <V2Stat icon="🗺️" tone="blue" value={territory ? regions.length : NA} label="Regions you work" />
          <V2Stat icon="📍" tone="teal" value={territory ? areaCount : NA} label="Areas covered" />
          <V2Stat icon="👥" tone="amber" value={territory ? peopleCount : NA} label={managing ? 'People in your regions' : 'Managers in your regions'} />
          <V2Stat icon="🤝" tone="purple" value={territory && regions.every((region) => typeof region.unownedLeads === 'number') ? regions.reduce((total, region) => total + (region.unownedLeads ?? 0), 0) : NA} label="Unowned leads" />
        </div>

        {state.kind === 'loading' ? <section className="v2-card"><p className="v2-empty">Loading…</p></section> : null}
        {state.kind === 'error' ? <section className="v2-card"><p className="v2-empty">{NA} — your territory could not be loaded.</p></section> : null}
        {territory && !regions.length ? <V2EmptyState icon="🗺️" title="No region assigned" note="You see your own leads anywhere; unowned leads appear once operations assigns you a region." /> : null}
        {regions.map((region) => (
          <section key={region.id} className="v2-card" aria-label={`Region ${region.name}`}>
            <div className="v2-card-head"><h2>{region.name}</h2>
              <V2Chip tone={region.myRole === 'MANAGER' ? 'purple' : 'teal'}>{region.myRole === 'MANAGER' ? 'You manage this region' : 'You work this region'}</V2Chip>
              <V2Chip tone="amber">{typeof region.unownedLeads === 'number' ? `${region.unownedLeads} unowned lead${region.unownedLeads === 1 ? '' : 's'}` : `${NA} unowned leads`}</V2Chip></div>
            <p className="v2-empty">{region.since ? `Since ${new Date(region.since).toLocaleDateString()}` : NA}</p>
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
