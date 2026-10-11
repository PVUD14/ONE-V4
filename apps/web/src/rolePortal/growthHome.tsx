/**
 * ONE · Role portal — Growth — the Home page (re-skin phase 7)
 *
 * The growth person's Home in the approved Momentum composition (inventory 06-screens/growth.html):
 * the gradient hero, their figures, the leads board, this week's field follow-ups, the territory
 * and the leads in it without an owner. It replaces the earlier home, which printed "NA" in the
 * target, commission and other slots that have no source.
 *
 * Every figure comes from a read this role already makes: their own workspace (`/growth/me`), the
 * field log, their leads, the lead vocabulary and their territory. A block renders only when its read
 * succeeded. Leads are organisations, not people, so their counts are exact.
 *
 * The approved page's target climb, field streak, targets-vs-achieved, commission amounts and
 * district map have no source yet (targets and commission rates are not built), so they are left
 * out rather than drawn with placeholder figures.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon.js';
import {
  ApiRequestError,
  getGrowthField,
  getGrowthLeadVocabulary,
  getGrowthMe,
  getGrowthTerritory,
  getProtectedAccessToken,
  listGrowthLeads,
  type GrowthFieldDto,
  type GrowthLeadSummaryDto,
  type GrowthLeadVocabularyDto,
  type GrowthMeDto,
  type GrowthTerritoryDto,
} from '../api.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { SupportCode } from '../supportCode.js';
import { formatDate } from '../dates.js';
import { growthCodeLabel } from './growthLeads.js';
import { IhCard, IhClear, IhKpis, IhNote, IhPage, RecordCount, go, shortDate, todayLabel } from './institutionMomentum.js';
import { Loading } from '../momentum/loader.js';

const teamLabels: Readonly<Record<string, string>> = {
  COLLEGE_PARTNERSHIPS: 'College partnerships',
  EMPLOYER_PARTNERSHIPS: 'Employer partnerships',
};
const staffTypeLabels: Readonly<Record<string, string>> = { EMPLOYEE: 'Employee', CONTRACTOR: 'Contractor' };
const roleLabels: Readonly<Record<string, string>> = { GROWTH_EXECUTIVE: 'Growth executive', GROWTH_MANAGER: 'Regional manager' };
/** Stages a lead leaves the active board at. */
const CLOSED_STAGES = new Set(['WON', 'LOST', 'SIGNED', 'CLOSED', 'CLOSED_WON', 'CLOSED_LOST', 'DISQUALIFIED']);

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export interface GrowthHomeData {
  readonly me: GrowthMeDto;
  readonly field: GrowthFieldDto | null;
  readonly leads: { readonly leads: readonly GrowthLeadSummaryDto[]; readonly more: boolean } | null;
  readonly vocabulary: GrowthLeadVocabularyDto | null;
  readonly territory: GrowthTerritoryDto | null;
}

type HomeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: GrowthHomeData }
  | { readonly kind: 'forbidden'; readonly reference: string | null }
  | { readonly kind: 'error'; readonly reference: string | null };

async function loadGrowthHome(token: string, signal: AbortSignal): Promise<HomeState> {
  try {
    const me = await getGrowthMe(token, signal);
    const [field, leads, vocabulary, territory] = await Promise.all([
      getGrowthField(token, 'MINE', signal).then((response) => (response && response.counts && Array.isArray(response.followUps) ? response : null)).catch(() => null),
      listGrowthLeads(token, { view: 'MINE' }, signal).then((response) => (Array.isArray(response?.leads) ? { leads: response.leads, more: Boolean(response.nextCursor) } : null)).catch(() => null),
      getGrowthLeadVocabulary(token, signal).then((response) => (response && response.stages ? response : null)).catch(() => null),
      getGrowthTerritory(token, signal).then((response) => (Array.isArray(response?.regions) ? response : null)).catch(() => null),
    ]);
    return { kind: 'ready', data: { me, field, leads, vocabulary, territory } };
  } catch (cause) {
    const reference = cause instanceof ApiRequestError ? cause.correlationId : null;
    return cause instanceof ApiRequestError && cause.status === 403 ? { kind: 'forbidden', reference } : { kind: 'error', reference };
  }
}

/** The board's columns: the vocabulary's stage order (college stages first), open stages only. */
function boardStages(leads: readonly GrowthLeadSummaryDto[], vocabulary: GrowthLeadVocabularyDto | null): readonly string[] {
  const ordered = vocabulary ? [...(vocabulary.stages.COLLEGE ?? []), ...(vocabulary.stages.EMPLOYER ?? [])] : leads.map((lead) => lead.stage);
  return [...new Set(ordered)].filter((stage) => !CLOSED_STAGES.has(stage));
}

function areaText(lead: GrowthLeadSummaryDto): string {
  return [lead.area.city, lead.area.districtName, lead.area.stateName].filter(Boolean).slice(0, 2).join(' · ');
}

// --- Blocks ------------------------------------------------------------------------------------

function GrowthHero({ me, field, onField }: { readonly me: GrowthMeDto; readonly field: GrowthFieldDto | null; readonly onField: () => void }): React.ReactElement {
  const next = field ? [...field.followUps].filter((item) => item.state === 'OPEN').sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] ?? null : null;
  const openLeads = typeof me.openLeads === 'number' ? me.openLeads : null;
  const due = typeof me.followUpsDue === 'number' ? me.followUpsDue : null;
  return <header className="bh-hero m-io m-loop" aria-labelledby="growth-hero-title">
    <div className="bh-hflow" aria-hidden="true" /><div className="bh-hsweep" aria-hidden="true" />
    <div>
      <div className="bh-hero-eyebrow"><Icon name="territory" size={16} />{[roleLabels[me.role] ?? growthCodeLabel(me.role), todayLabel()].join(' · ')}</div>
      <h1 id="growth-hero-title">{greeting()}.</h1>
      {openLeads !== null || due !== null ? <p>
        {openLeads !== null ? <>You own <b>{openLeads} open {plural(openLeads, 'lead', 'leads')}</b>.</> : null}
        {due !== null ? <> {due ? <><b>{due} {plural(due, 'follow-up is', 'follow-ups are')}</b> due today or earlier.</> : 'Nothing is due today.'}</> : null}
      </p> : <p>Your partnerships workspace.</p>}
      <div className="bh-hero-chips">
        {me.staffType ? <span className="bh-hero-chip">{staffTypeLabels[me.staffType] ?? growthCodeLabel(me.staffType)}</span> : null}
        {next ? <button type="button" className="bh-hero-chip" onClick={onField}><Icon name="calendar-small" size={16} />
          Next: {next.titleErased || !next.title ? 'Follow-up' : next.title} · {next.leadName} · {shortDate(`${next.dueOn}T00:00:00`) ?? next.dueOn}</button> : null}
      </div>
    </div>
    {field ? <div className="bh-hero-figs">
      <div className="bh-hero-fig"><b><RecordCount value={field.counts.activitiesThisMonth} /></b><small>{plural(field.counts.activitiesThisMonth, 'Activity', 'Activities')} logged this month</small></div>
      <div className="bh-hero-fig"><b><RecordCount value={field.counts.metThisMonth} /></b><small>Met in person this month</small></div>
    </div> : null}
  </header>;
}

function LeadsBoard({ leads, more, vocabulary, onOpen }: {
  readonly leads: readonly GrowthLeadSummaryDto[]; readonly more: boolean; readonly vocabulary: GrowthLeadVocabularyDto | null; readonly onOpen: () => void;
}): React.ReactElement {
  const stages = boardStages(leads, vocabulary);
  const active = leads.filter((lead) => !CLOSED_STAGES.has(lead.stage));
  return <IhCard title="Leads pipeline" link={{ label: 'Leads', onClick: onOpen }}
    aside={more ? `Your first ${leads.length} leads` : `${active.length} open`}>
    {active.length ? <div className="bh-board" style={{ '--n': stages.length } as React.CSSProperties} role="list" aria-label="Your open leads by stage">
      {stages.map((stage) => {
        const inStage = active.filter((lead) => lead.stage === stage);
        return <section key={stage} className="bh-col" role="listitem" aria-label={`${growthCodeLabel(stage)}: ${inStage.length}`}>
          <div className="bh-col-h"><span>{growthCodeLabel(stage)}</span><b>{inStage.length}</b></div>
          {inStage.slice(0, 2).map((lead, index) => <div key={lead.id} className="bh-lead" style={{ '--k': index } as React.CSSProperties}>
            <b>{lead.name}</b>
            <small>{[lead.kind === 'EMPLOYER' ? 'Employer' : 'College', areaText(lead)].filter(Boolean).join(' · ')}</small>
            {lead.lastActivityAt ? <small>Last activity {shortDate(lead.lastActivityAt)}</small> : null}
          </div>)}
          {inStage.length > 2 ? <div className="bh-more">+{inStage.length - 2} more</div> : null}
          {!inStage.length ? <div className="bh-col-empty">None here</div> : null}
        </section>;
      })}
    </div> : <p className="ih-empty">You own no open leads yet. Claim one from Leads, or add a new one.</p>}
    <IhNote>Growth sees organisations and their contacts only, never a student’s name, record or application.</IhNote>
  </IhCard>;
}

function FieldCard({ field, onOpen }: { readonly field: GrowthFieldDto; readonly onOpen: () => void }): React.ReactElement {
  const open = [...field.followUps].filter((item) => item.state === 'OPEN').sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const overdue = field.counts.followUpsOverdue;
  return <IhCard title="Field this week" aside={overdue ? <span className="tag t-warn"><i />{overdue} overdue</span> : <span className="tag t-ok"><i />Nothing overdue</span>}>
    {open.length ? <ul className="ih-list">{open.slice(0, 4).map((item) => {
      const when = new Date(`${item.dueOn}T00:00:00`);
      return <li key={item.id} className="ih-li">
        <span className="ih-date" aria-hidden="true"><small>{when.toLocaleDateString('en-GB', { weekday: 'short' })}</small><b>{when.getDate()}</b></span>
        <div className="ih-li-t"><b>{item.leadName}</b><small>{item.titleErased || !item.title ? 'Follow-up' : item.title}</small></div>
        {item.overdue ? <span className="tag t-warn"><i />Overdue</span> : item.dueToday ? <span className="tag t-band"><i />Today</span> : null}
      </li>;
    })}</ul> : <IhClear title="No follow-ups open" line="New follow-ups you add while logging a visit appear here." />}
    <div className="ih-btns"><button type="button" className="pilot-btn" onClick={onOpen}><Icon name="field" size={16} /> Log a visit</button></div>
  </IhCard>;
}

function TerritoryCard({ territory, onOpen }: { readonly territory: GrowthTerritoryDto; readonly onOpen: () => void }): React.ReactElement {
  return <IhCard title="Territory" link={{ label: 'Territory', onClick: onOpen }}
    aside={`${territory.regions.length} ${plural(territory.regions.length, 'region', 'regions')}`}>
    {territory.regions.length ? <ul className="ih-list">{territory.regions.map((region) => {
      const areas = region.areas.map((area) => (area.districtName ? area.districtName : `${area.stateName} (whole state)`));
      return <li key={region.id} className="ih-li">
        <span className="ih-li-i" aria-hidden="true"><Icon name="territory" size={16} /></span>
        <div className="ih-li-t"><b>{region.name}</b><small>{[areas.slice(0, 4).join(', ') + (areas.length > 4 ? ` +${areas.length - 4} more` : ''), region.since ? `Since ${formatDate(region.since)}` : null].filter(Boolean).join(' · ')}</small></div>
        {typeof region.unownedLeads === 'number' ? <span className="ih-muted">{region.unownedLeads} unowned</span> : null}
      </li>;
    })}</ul> : <p className="ih-empty">No region is assigned to you yet. Operations assigns regions in Settings.</p>}
  </IhCard>;
}

function UnownedCard({ count, onOpen }: { readonly count: number; readonly onOpen: () => void }): React.ReactElement {
  return <IhCard title="Unassigned leads" aside="Your territory">
    <div className="ih-calm">
      <span className="ih-calm-i" aria-hidden="true"><Icon name="leads" size={24} /></span>
      {count ? <><b>{count} {plural(count, 'lead has', 'leads have')} no owner</b><small>Claim a lead in your territory to start working it.</small></>
        : <><b>No unassigned leads</b><small>Every open lead in your territory has an owner. New enquiries land here first.</small></>}
      <button type="button" className="pilot-btn small" onClick={onOpen}><Icon name="leads" size={16} /> Open leads</button>
    </div>
  </IhCard>;
}

function TeamsCard({ me }: { readonly me: GrowthMeDto }): React.ReactElement {
  return <IhCard title="Your teams" aside="Set by operations">
    {me.teams.length ? <ul className="ih-list">{me.teams.map((team) => <li key={team.team} className="ih-li">
      <span className="ih-li-i" aria-hidden="true"><Icon name={team.team === 'COLLEGE_PARTNERSHIPS' ? 'organizations' : 'company'} size={16} /></span>
      <div className="ih-li-t"><b>{teamLabels[team.team] ?? growthCodeLabel(team.team)}</b><small>{team.manager ? `Manager: ${team.manager.email}` : 'No manager recorded'}</small></div>
      <span className="ih-muted">Since {formatDate(team.joinedAt)}</span>
    </li>)}</ul> : <p className="ih-empty">You are not on a team yet. Operations sets your team in Settings.</p>}
    <IhNote>Growth never sees a student’s name, record or application, cannot verify or approve an organisation, and cannot set a rate or record a payment.</IhNote>
  </IhCard>;
}

// --- Page --------------------------------------------------------------------------------------

export function GrowthHome(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<HomeState>({ kind: 'loading' });
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void loadGrowthHome(token, controller.signal).then((result) => { if (!controller.signal.aborted) setState(result); });
    return () => controller.abort();
  }, [token]);

  if (state.kind === 'forbidden') {
    return <V2EmptyState illustration="no-access" icon="🔐" title="Not permitted" note="The Growth workspace is for AI8HT's partnerships staff. Your access has not changed."
      {...(state.reference ? { hint: <SupportCode reference={state.reference} /> } : {})} />;
  }
  if (state.kind === 'error') {
    return <V2EmptyState illustration="500-something-went-wrong" icon="⚠️" title="Your growth details could not be loaded" note="Nothing on this page is shown until they load. Try again shortly."
      {...(state.reference ? { hint: <SupportCode reference={state.reference} /> } : {})} />;
  }
  const open = (path: string) => () => go(`/growth${path}`);
  if (state.kind === 'loading') {
    return <IhPage className="bh" title="Home" summary=""><Loading className="ih-empty">Loading your growth details…</Loading></IhPage>;
  }
  const { me, field, leads, vocabulary, territory } = state.data;
  const unowned = territory && territory.regions.some((region) => typeof region.unownedLeads === 'number')
    ? territory.regions.reduce((sum, region) => sum + (region.unownedLeads ?? 0), 0) : null;
  const areas = territory ? territory.regions.reduce((sum, region) => sum + region.areas.length, 0) : null;

  return <IhPage className="bh" title="Home" summary="" head={<GrowthHero me={me} field={field} onField={open('/field')} />}>
    <div role="region" aria-label="Growth summary">
      <IhKpis items={[
        typeof me.openLeads === 'number' && { key: 'leads', icon: 'leads', value: <RecordCount value={me.openLeads} />, label: 'Open leads' },
        typeof me.visitsThisMonth === 'number' && { key: 'visits', icon: 'field', value: <RecordCount value={me.visitsThisMonth} />, label: 'Visits this month' },
        typeof me.followUpsDue === 'number' && { key: 'due', icon: 'calendar', value: <RecordCount value={me.followUpsDue} />, label: 'Follow-ups due', note: 'Today or earlier' },
        areas !== null && territory && territory.regions.length > 0 && { key: 'areas', icon: 'territory', value: <RecordCount value={areas} />, label: areas === 1 ? 'Area in your territory' : 'Areas in your territory',
          note: `${territory.regions.length} ${plural(territory.regions.length, 'region', 'regions')}` },
        unowned !== null && { key: 'unowned', icon: 'leads', value: <RecordCount value={unowned} />, label: 'Unowned leads', note: 'In your territory' },
      ]} />
    </div>
    <div className="ih-grid">
      {leads ? <div className="ih-c12"><LeadsBoard leads={leads.leads} more={leads.more} vocabulary={vocabulary} onOpen={open('/leads')} /></div> : null}
      {territory ? <div className={field ? 'ih-c8' : 'ih-c12'}><TerritoryCard territory={territory} onOpen={open('/territory')} /></div> : null}
      {field ? <div className={territory ? 'ih-c4' : 'ih-c12'}><FieldCard field={field} onOpen={open('/field')} /></div> : null}
      <div className={unowned !== null ? 'ih-c8' : 'ih-c12'}><TeamsCard me={me} /></div>
      {unowned !== null ? <div className="ih-c4"><UnownedCard count={unowned} onOpen={open('/leads')} /></div> : null}
    </div>
  </IhPage>;
}
