/**
 * ONE · Role portal — Growth → Leads (GROWTH-03; design §5, §13, §16.1), and the lead detail panel
 * the Operations growth-admin section reuses.
 *
 * A growth person sees their own leads, the unowned leads of the regions they work, and (managers)
 * every lead of the regions they manage. They create a lead (the duplicate check answers without
 * naming another team's owner), claim an unowned one, add contacts — each with the permission
 * basis it was obtained under and whether the contact notice was given — and set do-not-contact.
 * Contacts are shown in full only to the lead's owner; anyone else sees them masked and must reveal
 * with a reason, which is audited. Every figure comes from a real row; an empty list says so.
 */
import { useEffect, useState } from 'react';
import {
  addGrowthLeadContact,
  ApiRequestError,
  claimGrowthLead,
  createGrowthLead,
  getGrowthLead,
  getGrowthLeadReassignOptions,
  getGrowthLeadVocabulary,
  getGrowthMe,
  getGrowthTerritory,
  getOperationsGrowthLead,
  getProtectedAccessToken,
  listGrowthLeads,
  reassignGrowthLead,
  recordGrowthContactNotice,
  removeGrowthLeadContact,
  revealGrowthLeadContact,
  setGrowthLeadDoNotContact,
  type GrowthLeadDetailDto,
  type GrowthLeadKindDto,
  type GrowthLeadSummaryDto,
  type GrowthLeadViewDto,
  type GrowthLeadVocabularyDto,
} from '../api.js';
import { V2Chip, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { formatApiError } from './shared.js';
import { LeadFieldPanel } from './growthField.js';

const NA = 'NA';

export function growthCodeLabel(code: string | null | undefined): string {
  if (!code) return NA;
  return code.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
}

const basisLabels: Readonly<Record<string, string>> = {
  PROVIDED_BY_PERSON: 'They gave it to us themselves',
  PUBLIC_INSTITUTIONAL_LISTING: 'Their organisation published it for enquiries',
  INTRODUCED_BY_COLLEAGUE: 'A colleague at their organisation passed it on',
};

function areaText(lead: GrowthLeadSummaryDto): string {
  const parts = [lead.area.city, lead.area.districtName, lead.area.stateName].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(', ') : 'Area not set';
}

/** Turns a refusal into words: the duplicate answer never names someone the caller cannot see. */
function leadError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError) {
    const code = cause.code;
    // The server words the duplicate answer itself, naming an owner only to someone who may see the lead.
    if (code === 'GROWTH_LEAD_DUPLICATE') return cause.detail ?? 'Already registered by another team member — ask your manager.';
    if (code === 'GROWTH_LEAD_DO_NOT_CONTACT') return 'This organisation asked not to be contacted. It cannot be added or worked.';
    if (code === 'GROWTH_ORGANIZATION_ALREADY_ON_ONE') return 'This employer is already on ONE. It is an existing account, not a new lead.';
    if (code === 'GROWTH_TEAM_MISMATCH') return 'You are not on the team that works this kind of lead.';
    if (code === 'GROWTH_LEAD_ALREADY_OWNED') return 'Someone claimed this lead first.';
    if (code === 'GROWTH_CONTACT_LIMIT_REACHED') return 'This lead already has the most contacts allowed. Remove one first.';
  }
  return formatApiError(cause, fallback);
}

type Mode = 'growth' | 'operations';

export function GrowthLeadsPage({ role }: { readonly role?: string | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const manager = role === 'GROWTH_MANAGER';
  const [vocabulary, setVocabulary] = useState<GrowthLeadVocabularyDto | null>(null);
  const [kind, setKind] = useState<GrowthLeadKindDto>('COLLEGE');
  const [view, setView] = useState<GrowthLeadViewDto>('ALL');
  const [search, setSearch] = useState('');
  const [leads, setLeads] = useState<readonly GrowthLeadSummaryDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [counts, setCounts] = useState<{ readonly open: number | null; readonly unowned: number | null }>({ open: null, unowned: null });

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    getGrowthLeadVocabulary(token, controller.signal).then(setVocabulary).catch(() => undefined);
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    Promise.all([getGrowthMe(token, controller.signal), getGrowthTerritory(token, controller.signal)])
      .then(([me, territory]) => setCounts({
        open: me.openLeads ?? null,
        unowned: territory.regions.every((region) => typeof region.unownedLeads === 'number')
          ? territory.regions.reduce((total, region) => total + (region.unownedLeads ?? 0), 0) : null,
      }))
      .catch(() => setCounts({ open: null, unowned: null }));
    return () => controller.abort();
  }, [token, reload]);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    setLeads(null);
    listGrowthLeads(token, { kind, view, ...(search.trim() ? { q: search.trim() } : {}) }, controller.signal)
      .then((page) => { setLeads(page.leads); setNextCursor(page.nextCursor); setError(''); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setLeads([]); setError(leadError(cause, 'Leads could not be loaded.')); } });
    return () => controller.abort();
  }, [token, kind, view, search, reload]);

  async function loadMore(): Promise<void> {
    if (!token || !nextCursor) return;
    try {
      const page = await listGrowthLeads(token, { kind, view, cursor: nextCursor, ...(search.trim() ? { q: search.trim() } : {}) });
      setLeads([...(leads ?? []), ...page.leads]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(leadError(cause, 'More leads could not be loaded.'));
    }
  }

  const shown = leads ?? [];
  const views: readonly [GrowthLeadViewDto, string][] = [['ALL', 'All you can see'], ['MINE', 'Mine'], ['UNOWNED', 'Unowned in my regions'], ...(manager ? [['NEEDS_OWNER', 'Needs a new owner'] as [GrowthLeadViewDto, string]] : [])];

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">ONE · Growth · Leads</p>
            <h1>Leads</h1>
            <p>Colleges and employers you are working. You see your own leads anywhere, and the unowned leads of the regions you work{manager ? '; as a manager, every lead in the regions you manage' : ''}.</p>
            <div className="v2-hero-chips">
              <button type="button" className="pilot-btn" onClick={() => setCreating(!creating)}>{creating ? 'Close new lead' : 'New lead'}</button>
            </div>
          </div>
        </div>

        <div className="v2-row v2-cols-4" role="region" aria-label="Leads summary">
          <V2Stat icon="🤝" tone="blue" value={counts.open ?? NA} label="Your open leads" />
          <V2Stat icon="📍" tone="teal" value={counts.unowned ?? NA} label="Unowned in your regions" />
          <V2Stat icon="📋" tone="amber" value={leads ? `${shown.length}${nextCursor ? '+' : ''}` : NA} label="In this list" />
          <V2Stat icon="⏳" tone="purple" value={leads ? shown.filter((lead) => lead.stale).length : NA} label="Stale in this list (90 days)" />
        </div>

        {creating && vocabulary && token ? <NewLeadForm vocabulary={vocabulary} token={token} defaultKind={kind}
          onCreated={(lead) => { setCreating(false); setSelected(lead.id); setReload((value) => value + 1); }} /> : null}

        <section className="v2-card" aria-label="Lead list">
          <div className="v2-card-head"><h2>{kind === 'COLLEGE' ? 'Colleges' : 'Employers'}</h2>
            <div className="role-actions">
              {(['COLLEGE', 'EMPLOYER'] as const).map((value) => <button key={value} type="button" className="pilot-btn" aria-pressed={kind === value}
                onClick={() => { setKind(value); setSelected(null); }}>{value === 'COLLEGE' ? 'Colleges' : 'Employers'}</button>)}
            </div></div>
          <div className="role-actions">
            <label>Show<select aria-label="Which leads" value={view} onChange={(event) => setView(event.target.value as GrowthLeadViewDto)}>
              {views.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select></label>
            <label>Search by name<input value={search} maxLength={80} onChange={(event) => setSearch(event.target.value)} /></label>
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {!leads ? <p className="v2-empty">Loading…</p> : shown.length ? <div className="v2-list">
            {shown.map((lead) => (
              <button key={lead.id} type="button" className="v2-list-row" aria-pressed={selected === lead.id} onClick={() => setSelected(lead.id)}>
                <span className="v2-tile teal" aria-hidden="true">{lead.kind === 'COLLEGE' ? '🏛️' : '🏢'}</span>
                <div className="grow"><strong>{lead.name}</strong><small>{areaText(lead)} · {growthCodeLabel(lead.stage)}</small></div>
                {lead.doNotContact ? <V2Chip tone="red">Do not contact</V2Chip>
                  : lead.owner ? <V2Chip tone={lead.owner.isMe ? 'green' : 'slate'}>{lead.owner.isMe ? 'Yours' : lead.owner.email ?? NA}</V2Chip>
                    : <V2Chip tone="amber">{lead.needsNewOwner ? 'Needs a new owner' : 'Unowned'}</V2Chip>}
                {lead.stale ? <V2Chip tone="purple">Stale</V2Chip> : null}
              </button>
            ))}
          </div> : <V2EmptyState icon="🤝" title="No leads here" note={view === 'MINE' ? 'You own no leads of this kind yet. Create one, or claim an unowned lead in your region.' : 'No lead of this kind matches. Leads appear here as your team adds them.'} />}
          {nextCursor ? <button type="button" className="pilot-btn" onClick={() => void loadMore()}>Load more</button> : null}
        </section>

        {selected && vocabulary && token ? <LeadDetailPanel key={selected} leadId={selected} vocabulary={vocabulary} token={token} mode="growth" manager={manager}
          onChanged={() => setReload((value) => value + 1)} /> : null}
      </div>

      <div className="v2-rail">
        <section className="v2-card">
          <div className="v2-card-head"><h2>Contact details are personal data</h2></div>
          <p className="v2-empty">{vocabulary?.purpose ?? NA} Add only details the person gave you, that their organisation published for enquiries, or that a colleague of theirs passed on. Never purchased lists, scraped data, or personal mobile numbers from anywhere else. They are erased 24 months after the lead&apos;s last activity.</p>
        </section>
        <section className="v2-card">
          <div className="v2-card-head"><h2>Contact notice</h2><V2Chip tone="amber">Draft for legal review</V2Chip></div>
          {vocabulary ? <>{vocabulary.notice.text.map((line) => <p key={line} className="v2-empty">{line}</p>)}<small>Version {vocabulary.notice.version}</small></> : <p className="v2-empty">{NA}</p>}
        </section>
      </div>
    </div>
  );
}

function NewLeadForm({ vocabulary, token, defaultKind, onCreated }: {
  readonly vocabulary: GrowthLeadVocabularyDto; readonly token: string; readonly defaultKind: GrowthLeadKindDto; readonly onCreated: (lead: GrowthLeadDetailDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ kind: defaultKind as string, name: '', stateCode: '', city: '', aisheCode: '', websiteDomain: '', source: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const states = vocabularyStates;
  return <section className="v2-card" aria-label="New lead">
    <div className="v2-card-head"><h2>New lead</h2><V2Chip tone="slate">You become its owner</V2Chip></div>
    <div className="role-actions">
      <label>Kind<select aria-label="Lead kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
        {vocabulary.kinds.map((value) => <option key={value} value={value}>{value === 'COLLEGE' ? 'College' : 'Employer'}</option>)}
      </select></label>
      <label>Organisation name<input value={form.name} maxLength={180} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>State<select aria-label="Lead state" value={form.stateCode} onChange={(event) => setForm({ ...form, stateCode: event.target.value })}>
        <option value="">Not known</option>{states.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      </select></label>
      <label>City or town<input value={form.city} maxLength={120} onChange={(event) => setForm({ ...form, city: event.target.value })} /></label>
      {form.kind === 'COLLEGE'
        ? <label>AISHE code (optional)<input value={form.aisheCode} maxLength={12} placeholder="C-12345" onChange={(event) => setForm({ ...form, aisheCode: event.target.value })} /></label>
        : <label>Website (once known)<input value={form.websiteDomain} maxLength={253} placeholder="company.com" onChange={(event) => setForm({ ...form, websiteDomain: event.target.value })} /></label>}
      <label>How you found it<select aria-label="Lead source" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })}>
        <option value="">Choose…</option>{vocabulary.sources.map((value) => <option key={value} value={value}>{growthCodeLabel(value)}</option>)}
      </select></label>
      <button type="button" className="pilot-btn" disabled={!form.name.trim() || !form.source || busy} onClick={() => void (async () => {
        setBusy(true);
        try {
          const created = await createGrowthLead(token, {
            kind: form.kind as GrowthLeadKindDto, name: form.name.trim(), stateCode: form.stateCode || null, city: form.city.trim() || null,
            aisheCode: form.kind === 'COLLEGE' ? form.aisheCode.trim() || null : null,
            websiteDomain: form.kind === 'EMPLOYER' ? form.websiteDomain.trim() || null : null, source: form.source,
          });
          onCreated(created.lead);
        } catch (cause) {
          setError(leadError(cause, 'The lead could not be created.'));
        } finally {
          setBusy(false);
        }
      })()}>Create lead</button>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}

/** The 36 ISO 3166-2:IN subdivisions, for the state picker (the server holds the same list). */
const vocabularyStates: readonly [string, string][] = [
  ['IN-AN', 'Andaman and Nicobar Islands'], ['IN-AP', 'Andhra Pradesh'], ['IN-AR', 'Arunachal Pradesh'], ['IN-AS', 'Assam'], ['IN-BR', 'Bihar'],
  ['IN-CH', 'Chandigarh'], ['IN-CG', 'Chhattisgarh'], ['IN-DH', 'Dadra and Nagar Haveli and Daman and Diu'], ['IN-DL', 'Delhi'], ['IN-GA', 'Goa'],
  ['IN-GJ', 'Gujarat'], ['IN-HR', 'Haryana'], ['IN-HP', 'Himachal Pradesh'], ['IN-JK', 'Jammu and Kashmir'], ['IN-JH', 'Jharkhand'],
  ['IN-KA', 'Karnataka'], ['IN-KL', 'Kerala'], ['IN-LA', 'Ladakh'], ['IN-LD', 'Lakshadweep'], ['IN-MP', 'Madhya Pradesh'], ['IN-MH', 'Maharashtra'],
  ['IN-MN', 'Manipur'], ['IN-ML', 'Meghalaya'], ['IN-MZ', 'Mizoram'], ['IN-NL', 'Nagaland'], ['IN-OD', 'Odisha'], ['IN-PY', 'Puducherry'],
  ['IN-PB', 'Punjab'], ['IN-RJ', 'Rajasthan'], ['IN-SK', 'Sikkim'], ['IN-TN', 'Tamil Nadu'], ['IN-TS', 'Telangana'], ['IN-TR', 'Tripura'],
  ['IN-UP', 'Uttar Pradesh'], ['IN-UK', 'Uttarakhand'], ['IN-WB', 'West Bengal'],
];

/**
 * One lead: area, owner, flags, contacts and history, with the acts the caller may take. `mode`
 * picks the growth routes or the Operations growth-admin routes; the server decides every act.
 */
export function LeadDetailPanel({ leadId, vocabulary, token, mode, manager, onChanged }: {
  readonly leadId: string; readonly vocabulary: GrowthLeadVocabularyDto; readonly token: string; readonly mode: Mode;
  readonly manager: boolean; readonly onChanged: () => void;
}): React.ReactElement {
  const operations = mode === 'operations';
  const [lead, setLead] = useState<GrowthLeadDetailDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Readonly<Record<string, { readonly email: string | null; readonly phone: string | null }>>>({});
  const [reasons, setReasons] = useState({ remove: '', reveal: '', dnc: '', reassign: '' });
  const [options, setOptions] = useState<readonly { readonly membershipId: string; readonly email: string }[] | null>(null);
  const [target, setTarget] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    (operations ? getOperationsGrowthLead : getGrowthLead)(token, leadId, controller.signal)
      .then((result) => setLead(result.lead))
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(leadError(cause, 'The lead could not be loaded.')); });
    return () => controller.abort();
  }, [leadId, token, operations]);

  async function act(action: () => Promise<{ readonly lead: GrowthLeadDetailDto } | unknown>, done: string): Promise<void> {
    setBusy(true);
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'lead' in result) setLead((result as { lead: GrowthLeadDetailDto }).lead);
      setNotice(done);
      setError('');
      onChanged();
    } catch (cause) {
      setError(leadError(cause, 'The change could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  if (!lead) return <section className="v2-card" aria-label="Lead detail">{error ? <p className="form-error" role="alert">{error}</p> : <p className="v2-empty">Loading…</p>}</section>;
  const owner = lead.owner?.isMe === true;
  const canReassign = operations || manager;
  const removeReasons = operations ? vocabulary.reasons.adminRemoveContact : vocabulary.reasons.removeContact;
  const reassignReasons = operations ? vocabulary.reasons.adminReassign : vocabulary.reasons.reassign;
  const open = !lead.handedOff && lead.stage !== 'LOST';

  return <section className="v2-card" aria-label={`Lead ${lead.name}`}>
    <div className="v2-card-head"><h2>{lead.name}</h2><V2Chip tone="blue">{growthCodeLabel(lead.stage)}</V2Chip></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <p>{lead.kind === 'COLLEGE' ? 'College' : 'Employer'} · {areaText(lead)}{lead.aisheCode ? ` · AISHE ${lead.aisheCode}` : ''}{lead.websiteDomain ? ` · ${lead.websiteDomain}` : ''}</p>
    <p>Owner: {lead.owner ? (owner ? 'you' : lead.owner.email ?? NA) : lead.needsNewOwner ? 'nobody — the previous owner left' : 'nobody (unowned)'} · Found by {growthCodeLabel(lead.source)} · Last activity {lead.lastActivityAt ? new Date(lead.lastActivityAt).toLocaleDateString() : NA}</p>
    <div className="v2-hero-chips">
      {lead.doNotContact ? <V2Chip tone="red">Do not contact ({growthCodeLabel(lead.doNotContact.reasonCode)})</V2Chip> : null}
      {lead.possibleDuplicate ? <V2Chip tone="amber">Possible duplicate — check with your manager</V2Chip> : null}
      {lead.stale ? <V2Chip tone="purple">Stale: no activity for 90 days</V2Chip> : null}
      {lead.handedOff ? <V2Chip tone="green">Handed off to operations</V2Chip> : null}
    </div>

    {!operations && !lead.owner && !lead.doNotContact && open ? <button type="button" className="pilot-btn" disabled={busy}
      onClick={() => void act(() => claimGrowthLead(token, lead.id), 'You now own this lead.')}>Claim this lead</button> : null}

    <h3>Contacts</h3>
    {lead.contacts.length ? <ul className="role-check-list">{lead.contacts.map((contact) => {
      const shown = revealed[contact.id];
      const email = shown ? shown.email : contact.email;
      const phone = shown ? shown.phone : contact.phone;
      return <li key={contact.id} aria-label={`Contact ${contact.fullName}`}>
        <strong>{contact.fullName}</strong> · {growthCodeLabel(contact.role)}
        <div>{email ? (owner && !contact.masked ? <a href={`mailto:${email}`}>{email}</a> : email) : null}{email && phone ? ' · ' : ''}{phone ? (owner && !contact.masked ? <a href={`tel:${phone.replace(/[^0-9+]/g, '')}`}>{phone}</a> : phone) : null}</div>
        <small>{basisLabels[contact.permissionBasis] ?? growthCodeLabel(contact.permissionBasis)} ({growthCodeLabel(contact.source)}) · {contact.notice ? `Notice given ${contact.notice.givenAt ? new Date(contact.notice.givenAt).toLocaleDateString() : ''} (${contact.notice.version ?? NA})` : 'Notice not yet given'}</small>
        <span className="role-actions">
          {owner && !contact.notice && !lead.doNotContact ? <button type="button" className="pilot-btn" disabled={busy}
            onClick={() => void act(() => recordGrowthContactNotice(token, lead.id, contact.id), 'Notice recorded.')}>Record notice given</button> : null}
          {contact.masked && !shown ? <button type="button" className="pilot-btn" disabled={!reasons.reveal || busy}
            onClick={() => void act(async () => {
              const result = await revealGrowthLeadContact(token, lead.id, contact.id, { reasonCode: reasons.reveal }, operations);
              setRevealed({ ...revealed, [contact.id]: { email: result.contact.email, phone: result.contact.phone } });
              return result;
            }, 'Shown. The reveal is recorded.')}>Reveal</button> : null}
          {(owner || canReassign) ? <button type="button" className="pilot-btn" disabled={!reasons.remove || busy}
            onClick={() => void act(() => removeGrowthLeadContact(token, lead.id, contact.id, { reasonCode: reasons.remove }, operations), 'Contact removed: name, email and phone are erased.')}>Remove</button> : null}
        </span>
      </li>;
    })}</ul> : <p className="v2-empty">No contacts{lead.removedContacts ? ` (${lead.removedContacts} removed and erased)` : ''}.</p>}
    {lead.contacts.some((contact) => contact.masked) ? <ReasonPicker label="Reason to reveal a contact" reasons={vocabulary.reasons.revealContact} value={reasons.reveal} onChange={(value) => setReasons({ ...reasons, reveal: value })} /> : null}
    {lead.contacts.length && (owner || canReassign) ? <ReasonPicker label="Reason to remove a contact" reasons={removeReasons} value={reasons.remove} onChange={(value) => setReasons({ ...reasons, remove: value })} /> : null}
    {!operations && owner && !lead.doNotContact ? <ContactForm vocabulary={vocabulary} busy={busy} limitReached={lead.contacts.length >= vocabulary.contactLimit}
      onSubmit={(body) => act(() => addGrowthLeadContact(token, lead.id, body), 'Contact added.')} /> : null}

    {canReassign && open && !lead.doNotContact ? <div className="role-actions" aria-label="Reassign">
      <button type="button" className="pilot-btn" disabled={busy} onClick={() => void getGrowthLeadReassignOptions(token, lead.id, operations)
        .then((result) => setOptions(result.options)).catch((cause: unknown) => setError(leadError(cause, 'Owners could not be loaded.')))}>Choose a new owner</button>
      {options ? <label>New owner<select aria-label="New owner" value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value="">Choose…</option><option value="none">Nobody (unowned)</option>
        {options.map((option) => <option key={option.membershipId} value={option.membershipId}>{option.email}</option>)}
      </select></label> : null}
      <ReasonPicker label="Reason to reassign" reasons={reassignReasons} value={reasons.reassign} onChange={(value) => setReasons({ ...reasons, reassign: value })} />
      <button type="button" className="pilot-btn" disabled={!target || !reasons.reassign || busy}
        onClick={() => void act(() => reassignGrowthLead(token, lead.id, { toMembershipId: target === 'none' ? null : target, reasonCode: reasons.reassign }, operations), 'Lead reassigned.')}>Reassign</button>
    </div> : null}

    {!lead.doNotContact && (owner || canReassign) ? <div className="role-actions" aria-label="Do not contact">
      <ReasonPicker label="Reason to stop all contact" reasons={vocabulary.reasons.doNotContact} value={reasons.dnc} onChange={(value) => setReasons({ ...reasons, dnc: value })} />
      <button type="button" className="pilot-btn" disabled={!reasons.dnc || busy}
        onClick={() => void act(() => setGrowthLeadDoNotContact(token, lead.id, { reasonCode: reasons.dnc }, operations), 'Marked do not contact. This cannot be undone.')}>Mark do not contact</button>
    </div> : null}

    {!operations ? <LeadFieldPanel leadId={lead.id} token={token} contacts={lead.contacts} /> : null}

    <h3>Owner history</h3>
    <ul>{lead.ownerHistory.map((entry, index) => <li key={`${entry.at ?? ''}-${index}`}>{entry.at ? new Date(entry.at).toLocaleDateString() : NA}: {growthCodeLabel(entry.reasonCode)} — {entry.from ?? 'nobody'} → {entry.to ?? 'nobody'}</li>)}</ul>
  </section>;
}

function ReasonPicker({ label, reasons, value, onChange }: { readonly label: string; readonly reasons: readonly string[]; readonly value: string; readonly onChange: (value: string) => void }): React.ReactElement {
  return <label>{label}<select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Reason…</option>{reasons.map((code) => <option key={code} value={code}>{growthCodeLabel(code)}</option>)}
  </select></label>;
}

function ContactForm({ vocabulary, busy, limitReached, onSubmit }: {
  readonly vocabulary: GrowthLeadVocabularyDto; readonly busy: boolean; readonly limitReached: boolean;
  readonly onSubmit: (body: { role: string; fullName: string; email: string | null; phone: string | null; permissionBasis: string; source: string; noticeGiven: boolean }) => Promise<void>;
}): React.ReactElement {
  const empty = { role: '', fullName: '', email: '', phone: '', permissionBasis: '', source: '', noticeGiven: false };
  const [form, setForm] = useState(empty);
  const sources = form.permissionBasis ? vocabulary.contactSourcesByBasis[form.permissionBasis] ?? [] : [];
  const ready = form.role && form.fullName.trim() && (form.email.trim() || form.phone.trim()) && form.permissionBasis && form.source && !limitReached;
  return <fieldset aria-label="Add a contact"><legend>Add a contact</legend>
    <p className="v2-empty">{vocabulary.purpose} Only these sources are allowed. Never purchased lists, scraped data, or personal mobile numbers from any other source.</p>
    <div className="role-actions">
      <label>Role<select aria-label="Contact role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
        <option value="">Choose…</option>{vocabulary.contactRoles.map((value) => <option key={value} value={value}>{growthCodeLabel(value)}</option>)}
      </select></label>
      <label>Name<input aria-label="Contact name" value={form.fullName} maxLength={120} onChange={(event) => setForm({ ...form, fullName: event.target.value })} /></label>
      <label>Work email<input aria-label="Contact email" type="email" value={form.email} maxLength={254} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
      <label>Phone<input aria-label="Contact phone" value={form.phone} maxLength={24} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label>How we got it<select aria-label="Permission basis" value={form.permissionBasis} onChange={(event) => setForm({ ...form, permissionBasis: event.target.value, source: '' })}>
        <option value="">Choose…</option>{Object.keys(vocabulary.contactSourcesByBasis).map((value) => <option key={value} value={value}>{basisLabels[value] ?? growthCodeLabel(value)}</option>)}
      </select></label>
      <label>Source<select aria-label="Contact source" value={form.source} disabled={!form.permissionBasis} onChange={(event) => setForm({ ...form, source: event.target.value })}>
        <option value="">Choose…</option>{sources.map((value) => <option key={value} value={value}>{growthCodeLabel(value)}</option>)}
      </select></label>
      <label><input type="checkbox" checked={form.noticeGiven} onChange={(event) => setForm({ ...form, noticeGiven: event.target.checked })} /> I gave or sent them the contact notice</label>
      <button type="button" className="pilot-btn" disabled={!ready || busy} onClick={() => void onSubmit({
        role: form.role, fullName: form.fullName.trim(), email: form.email.trim() || null, phone: form.phone.trim() || null,
        permissionBasis: form.permissionBasis, source: form.source, noticeGiven: form.noticeGiven,
      }).then(() => setForm(empty))}>Add contact</button>
    </div>
    {limitReached ? <small>This lead already has {vocabulary.contactLimit} contacts. Remove one to add another.</small> : null}
  </fieldset>;
}
