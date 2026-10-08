/**
 * ONE · Role portal — Operations sections for the lead register (GROWTH-03; design §5.4, §13.4).
 *
 *  - Settings → Growth leads (GROWTH_ADMIN): every region's leads, contacts masked, with reveal,
 *    reassignment anywhere, do-not-contact and contact removal — each with a reason.
 *  - Security → Privacy → Growth lead contacts (PRIVACY_REQUESTS): a contact is not a ONE user, so
 *    their access and erasure requests are answered here — look up by email or phone, then erase
 *    every matching contact and, if they asked, stop all contact with their organisations.
 *
 * Sections of existing screens, no navigation item (O-24). Each renders nothing for an operator
 * without its capability.
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  eraseGrowthContacts,
  getProtectedAccessToken,
  listOperationsGrowthLeads,
  lookupGrowthContacts,
  type GrowthContactLookupMatchDto,
  type GrowthLeadKindDto,
  type GrowthLeadSummaryDto,
  type GrowthLeadViewDto,
  type GrowthLeadVocabularyDto,
} from '../api.js';
import { requestJson } from '../api/http.js';
import { V2Chip, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { growthCodeLabel, LeadDetailPanel } from './growthLeads.js';
import { formatApiError } from './shared.js';
import { formatDate } from '../dates.js';

export function OperationsGrowthLeadsPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [kind, setKind] = useState<GrowthLeadKindDto>('COLLEGE');
  const [view, setView] = useState<GrowthLeadViewDto>('ALL');
  const [search, setSearch] = useState('');
  const [leads, setLeads] = useState<readonly GrowthLeadSummaryDto[] | null>(null);
  const [vocabulary, setVocabulary] = useState<GrowthLeadVocabularyDto | null>(null);
  const [more, setMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    listOperationsGrowthLeads(token, { kind, view, ...(search.trim() ? { q: search.trim() } : {}) }, controller.signal)
      .then((page) => { setLeads(page.leads); setVocabulary(page.vocabulary); setMore(page.nextCursor !== null); setError(''); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbidden(true);
        else setError(formatApiError(cause, 'Growth leads could not be loaded.'));
      });
    return () => controller.abort();
  }, [token, kind, view, search, reload]);

  if (!token || forbidden) return null;
  if (!leads && !error) return null;
  const shown = leads ?? [];

  return <section className="role-module role-module--dense" aria-labelledby="growth-leads-admin-heading">
    <div className="role-page-heading"><div><span className="eyebrow">Settings</span><h1 id="growth-leads-admin-heading">Growth leads</h1>
      <p>Every region&apos;s leads. Contacts stay masked: reveal one only with a reason, which is recorded. Reassign, stop contact, or remove a contact on a person&apos;s request here.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide" role="region" aria-label="Growth leads summary">
      <V2Stat icon="📋" tone="blue" value={`${shown.length}${more ? '+' : ''}`} label="In this list" />
      <V2Stat icon="📍" tone="amber" value={shown.filter((lead) => !lead.owner).length} label="Unowned in this list" />
      <V2Stat icon="🧭" tone="teal" value={shown.filter((lead) => lead.needsNewOwner).length} label="Owner left" />
      <V2Stat icon="⛔" tone="purple" value={shown.filter((lead) => lead.doNotContact).length} label="Do not contact" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-card role-wide">
      <div className="role-actions">
        <label>Kind<select aria-label="Lead kind filter" value={kind} onChange={(event) => { setKind(event.target.value as GrowthLeadKindDto); setSelected(null); }}>
          <option value="COLLEGE">Colleges</option><option value="EMPLOYER">Employers</option>
        </select></label>
        <label>Show<select aria-label="Lead view filter" value={view} onChange={(event) => setView(event.target.value as GrowthLeadViewDto)}>
          <option value="ALL">All</option><option value="UNOWNED">Unowned</option><option value="NEEDS_OWNER">Owner left</option>
        </select></label>
        <label>Search by name<input aria-label="Search growth leads" value={search} maxLength={80} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      {shown.length ? <ul className="role-check-list">{shown.map((lead) => <li key={lead.id}>
        <button type="button" className="pilot-btn" aria-pressed={selected === lead.id} onClick={() => setSelected(lead.id)}>{lead.name}</button>
        {' '}<small>{[lead.area.districtName, lead.area.stateName].filter(Boolean).join(', ') || 'Area not set'} · {growthCodeLabel(lead.stage)} · {lead.owner ? lead.owner.email ?? 'NA' : 'unowned'}</small>
        {lead.doNotContact ? <> <V2Chip tone="red">Do not contact</V2Chip></> : null}
      </li>)}</ul> : <V2EmptyState icon="🤝" title="No leads" note="No growth lead of this kind matches." />}
      {more ? <p>Showing the newest 50. Narrow the search to find older leads.</p> : null}
    </section>
    {selected && vocabulary ? <LeadDetailPanel key={selected} leadId={selected} vocabulary={vocabulary} token={token} mode="operations" manager={false}
      onChanged={() => setReload((value) => value + 1)} /> : null}
  </section>;
}

export function OperationsGrowthContactsPrivacyPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [keyKind, setKeyKind] = useState<'email' | 'phone'>('email');
  const [value, setValue] = useState('');
  const [reference, setReference] = useState('');
  const [matches, setMatches] = useState<readonly GrowthContactLookupMatchDto[] | null>(null);
  const [stopContact, setStopContact] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    requestJson('/api/v1/operations/privacy/growth-contacts/policy', { token, signal: controller.signal })
      .then(() => setAllowed(true))
      .catch(() => { if (!controller.signal.aborted) setAllowed(false); });
    return () => controller.abort();
  }, [token]);

  if (!token || !allowed) return null;
  const key = keyKind === 'email' ? { email: value.trim() } : { phone: value.trim() };
  const ready = value.trim() && /^[A-Za-z0-9_:-]{3,64}$/.test(reference.trim());
  const live = (matches ?? []).filter((match) => !match.removedAt);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await action(); setError(''); } catch (cause) { setError(formatApiError(cause, 'The request could not be completed.')); } finally { setBusy(false); }
  }

  return <section className="role-card role-wide" aria-labelledby="growth-contacts-privacy-heading">
    <h2 id="growth-contacts-privacy-heading">Growth lead contacts</h2>
    <p>People at prospective colleges and employers are not ONE users. When one asks what AI8HT holds about them, or asks for it to be erased, answer here. Every lookup and erasure is recorded against the request reference; the email or phone itself is not written to the audit record.</p>
    <div className="role-actions">
      <label>Look up by<select aria-label="Look up by" value={keyKind} onChange={(event) => { setKeyKind(event.target.value as 'email' | 'phone'); setMatches(null); }}>
        <option value="email">Email</option><option value="phone">Phone</option>
      </select></label>
      <label>{keyKind === 'email' ? 'Email' : 'Phone'}<input aria-label="Contact to look up" value={value} maxLength={254} onChange={(event) => { setValue(event.target.value); setMatches(null); }} /></label>
      <label>Request reference<input aria-label="Request reference" value={reference} maxLength={64} placeholder="PRQ-…" onChange={(event) => setReference(event.target.value)} /></label>
      <button type="button" className="pilot-btn" disabled={!ready || busy} onClick={() => void run(async () => {
        const result = await lookupGrowthContacts(token, { ...key, reference: reference.trim() });
        setMatches(result.matches); setConfirm(false); setNotice('');
      })}>Look up</button>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {matches ? (live.length ? <div aria-label="What we hold">
      <p>{live.length} contact record{live.length === 1 ? '' : 's'} hold this {keyKind}. This is what to send the person:</p>
      <ul className="role-check-list">{live.map((match) => <li key={match.contactId}>
        <strong>{match.organisation}</strong> ({match.kind === 'COLLEGE' ? 'college' : 'employer'}) · {growthCodeLabel(match.contactRole)}
        <div>{match.fullName} · {match.email ?? '—'} · {match.phone ?? '—'}</div>
        <small>How we got it: {growthCodeLabel(match.permissionBasis)} ({growthCodeLabel(match.source)}) · added {formatDate(match.addedAt)} · {match.noticeGivenAt ? `notice given ${formatDate(match.noticeGivenAt)} (${match.noticeVersion ?? 'NA'})` : 'no notice recorded'}{match.leadDoNotContact ? ' · organisation marked do not contact' : ''}</small>
      </li>)}</ul>
      <label><input type="checkbox" checked={stopContact} onChange={(event) => setStopContact(event.target.checked)} /> They asked not to be contacted at all: mark their organisations do not contact</label>
      <label><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} /> I understand erasure cannot be undone</label>
      <button type="button" className="pilot-btn" disabled={!confirm || busy} onClick={() => void run(async () => {
        const result = await eraseGrowthContacts(token, { ...key, reference: reference.trim(), doNotContact: stopContact });
        setMatches(null); setConfirm(false);
        setNotice(`Erased ${result.removed} contact record${result.removed === 1 ? '' : 's'}${stopContact ? `; ${result.doNotContactLeads} organisation${result.doNotContactLeads === 1 ? '' : 's'} marked do not contact` : ''}.`);
      })}>Erase these contacts</button>
    </div> : <p>No growth lead contact holds this {keyKind}{matches.length ? ' any more (only erased records remain)' : ''}.</p>) : null}
  </section>;
}
