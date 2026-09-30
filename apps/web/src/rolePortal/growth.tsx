/**
 * ONE · Role portal — the Growth workspace (GROWTH-01, ADR-040).
 *
 * The Home page in the pilot's composition (greeting hero, stat tiles, cards) and the other
 * approved navigation items (HG-3, 2026-09-30). In GROWTH-01 the only real facts are the
 * person's own role, teams, manager and staff type (`GET /api/v1/growth/me`). Every figure
 * whose source is not built yet shows NA in its slot, and every other page says plainly that
 * it is not built yet. No lead, visit, target or amount is invented, in any state.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getGrowthMe, getProtectedAccessToken, type GrowthMeDto } from '../api.js';
import { V2Chip, V2EmptyState, V2Ring, V2Stat } from '../dashboardsV2.js';
import type { RoleNavItem } from '../rolePortalConfig.js';
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
  Leads: 'Leads is not built yet. When it is, your college and employer leads, their stages and their contacts will be here.',
  Field: 'Field is not built yet. When it is, you will log visits, calls and follow-ups here and on the ONE app.',
  Territory: 'Territory is not built yet. When it is, the regions you work and the unowned leads in them will be here.',
  Targets: 'Targets is not built yet. When it is, your targets for the month and quarter, and progress counted from real records, will be here.',
  Commission: 'Commission is not built yet. Commission rates have not been set by operations, so no amount is shown anywhere.',
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
          <V2Stat icon="🤝" tone="blue" value={NA} label="Open leads" />
          <V2Stat icon="📍" tone="teal" value={NA} label="Visits this month" />
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
        <section className="v2-card">
          <div className="v2-card-head"><h2>Coming next</h2><V2Chip tone="slate">Not built yet</V2Chip></div>
          <p className="v2-empty">Leads, field visits, territory, targets and commission are not built yet. Each page says so until it is, and every figure above reads NA until it has a real source.</p>
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
  return <AuthenticatedNotYetAvailable title={route.label} detail={notBuilt[route.label] ?? `${route.label} is not built yet.`} />;
}
