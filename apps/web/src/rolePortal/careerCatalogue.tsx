/**
 * ONE · Role portal — Operations Content Management: the job-role catalogue (OPS-08).
 *
 * Lives under the existing Content Management label (Appendix 1 §4.2), above what that
 * label already showed. Operators search the 108 catalogue roles by code, name, branch and
 * synonym, filter by family, branch and release label, open a role, keep its synonyms,
 * and take a requirement set from draft through review by someone other than its author
 * to a publish that a second person must approve (Settings → Approvals).
 *
 * The server decides everything — capabilities, reason codes, who may review, and whether
 * a publish may run. Planned releases are shown as the plan they are; a role reads "Not
 * yet verified" until an approved publish says otherwise. Missing values read NA.
 */
import { useEffect, useRef, useState } from 'react';
import {
  addCareerRoleSynonym,
  ApiRequestError,
  createCareerRequirementDraft,
  getCareerCataloguePolicy,
  getCatalogueRole,
  getProtectedAccessToken,
  listCatalogueRoles,
  removeCareerRoleSynonym,
  saveCareerRequirementItems,
  searchCatalogueTopics,
  transitionCareerRequirementSet,
} from '../api.js';
import type {
  CareerCataloguePolicyDto,
  CareerRequirementLevel,
  CareerRequirementSetState,
  CatalogueRoleDetailDto,
  CatalogueRoleDto,
  CatalogueRoleListDto,
  RequirementItemDto,
  RequirementSetDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError } from './shared.js';

const noteLimit = 500;
const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');

/** A role's honest label: nothing is verified until an approved publish says so. */
export function releaseLabelText(releaseLabel: string | null): string {
  return releaseLabel === 'VERIFIED' ? 'Verified' : releaseLabel === 'SELECTABLE' ? 'Not yet verified' : 'NA';
}
const plannedText = (planned: string | null): string => (planned ? `${planned} (planned)` : 'Selectable (no plan)');
const setTone = (state: CareerRequirementSetState): 'success' | 'warning' | 'neutral' | 'info' =>
  state === 'PUBLISHED' ? 'success' : state === 'IN_REVIEW' || state === 'REVIEWED' ? 'warning' : state === 'DRAFT' ? 'info' : 'neutral';

export function OperationsCareerCataloguePage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [policy, setPolicy] = useState<CareerCataloguePolicyDto | null>(null);
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [draftFilters, setDraftFilters] = useState({ q: '', family: '', branch: '', releaseLabel: '' });
  const [filters, setFilters] = useState(draftFilters);
  const [list, setList] = useState<CatalogueRoleListDto | null>(null);
  const [more, setMore] = useState<readonly CatalogueRoleDto[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getCareerCataloguePolicy(token, controller.signal)
      .then((result) => { setPolicy(result); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the catalogue policy.'));
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || forbiddenReference) return;
    const controller = new AbortController();
    setLoading(true);
    listCatalogueRoles(token, filters, null, controller.signal)
      .then((result) => { setList(result); setMore([]); setMoreCursor(null); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the job-role catalogue.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, filters, reload, forbiddenReference]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Content Management</span><h1>Job-role catalogue</h1>
    <p>The 108 campus roles students choose from. Requirement sets are drafted, reviewed by someone other than their author, and published only with a second person&apos;s approval. Planned releases are the plan, not a claim: a role reads &quot;Not yet verified&quot; until an approved publish says otherwise.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="The job-role catalogue is for staff who hold Catalogue Manage, Content Review or Content Publish. Your access has not changed; the content studio below is unaffected."
        hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const roles = [...(list?.roles ?? []), ...more];
  const nextCursor = more.length ? moreCursor : list?.nextCursor ?? null;
  const summary = list?.summary;
  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await listCatalogueRoles(token, filters, nextCursor);
      setMoreCursor(page.nextCursor);
      setMore((current) => [...current, ...page.roles]);
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to load more roles.'));
    }
  };

  return <section className="role-module role-module--dense" aria-label="Job-role catalogue">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🗂️" tone="blue" value={summary ? summary.totalRoles : 'NA'} label="Roles in the catalogue" />
      <V2Stat icon="✅" tone="teal" value={summary ? summary.verified : 'NA'} label="Verified" />
      <V2Stat icon="🧭" tone="purple" value={summary ? summary.selectable : 'NA'} label="Not yet verified" />
      <V2Stat icon="📝" tone="amber" value={summary ? summary.setsInReview + summary.setsReviewed : 'NA'} label="Sets awaiting review or publish" />
    </div>
    <p role="note">Students see: {policy ? (policy.studentFlag.enabled ? 'the full catalogue, each role with its label' : 'the starter roles only — the full catalogue is behind the career-catalogue.selectable-roles flag, which is off') : 'NA'}.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-card role-wide"><h2>Roles</h2>
      <form className="role-actions" aria-label="Search the catalogue" onSubmit={(event) => { event.preventDefault(); setFilters(draftFilters); }}>
        <label className="role-local-search"><span>Search</span>
          <input value={draftFilters.q} maxLength={120} placeholder="Code, name, branch or synonym" onChange={(event) => setDraftFilters({ ...draftFilters, q: event.target.value })} /></label>
        <label className="role-local-search"><span>Family</span>
          <select aria-label="Family filter" value={draftFilters.family} onChange={(event) => setDraftFilters({ ...draftFilters, family: event.target.value })}>
            <option value="">All families</option>
            {(policy?.families ?? []).map((family) => <option key={family.code} value={family.code}>{family.code}. {family.label}</option>)}
          </select></label>
        <label className="role-local-search"><span>Branch</span>
          <select aria-label="Branch filter" value={draftFilters.branch} onChange={(event) => setDraftFilters({ ...draftFilters, branch: event.target.value })}>
            <option value="">Any branch</option>
            {(policy?.branches ?? []).map((branch) => <option key={branch} value={branch}>{branch}</option>)}
          </select></label>
        <label className="role-local-search"><span>Label</span>
          <select aria-label="Release label filter" value={draftFilters.releaseLabel} onChange={(event) => setDraftFilters({ ...draftFilters, releaseLabel: event.target.value })}>
            <option value="">Any label</option>
            {(policy?.releaseLabels ?? []).map((value) => <option key={value} value={value}>{releaseLabelText(value)}</option>)}
          </select></label>
        <button type="submit" className="pilot-btn">Search</button>
      </form>
      {loading && !list ? <p>Loading the catalogue…</p> : null}
      {!loading && list && !roles.length ? <V2EmptyState icon="🔎" title="No roles match" note="No catalogue role matches this search. The catalogue itself is loaded by the catalogue seed; if it is empty here, it has not been loaded yet." /> : null}
      {roles.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Code</th><th>Role</th><th>Family</th><th>Typical branches</th><th>Plan</th><th>Label</th><th>Live requirements</th><th>Requirement set</th><th>Actions</th></tr></thead>
        <tbody>{roles.map((role) => <tr key={role.id}>
          <td><strong>{role.catalogueCode ?? 'NA'}</strong>{role.origin === 'STARTER' ? <><br /><small>{role.code}</small></> : null}</td>
          <td>{role.title}{role.catalogueTitle && role.catalogueTitle !== role.title ? <><br /><small>Catalogue: {role.catalogueTitle}</small></> : null}</td>
          <td>{role.catalogueFamily ?? 'NA'}</td>
          <td>{role.eligibleBranches.length ? role.eligibleBranches.join(', ') : 'NA'}</td>
          <td>{plannedText(role.plannedRelease)}</td>
          <td><StatusBadge label={releaseLabelText(role.releaseLabel)} tone={role.releaseLabel === 'VERIFIED' ? 'success' : 'neutral'} /></td>
          <td>{role.liveRequirementCount}</td>
          <td>{role.openSetState ? label(role.openSetState) : role.publishedVersion ? `Published v${role.publishedVersion}` : 'None'}</td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(role.id)}>Open {role.catalogueCode ?? role.code}</button></td>
        </tr>)}</tbody></table></div> : null}
      {nextCursor ? <button type="button" className="secondary" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
    {selectedId && policy ? <CatalogueRolePanel token={token} roleId={selectedId} policy={policy}
      onChanged={() => setReload((value) => value + 1)} onClose={() => setSelectedId('')} /> : null}
  </section>;
}

function CatalogueRolePanel({ token, roleId, policy, onChanged, onClose }: {
  readonly token: string; readonly roleId: string; readonly policy: CareerCataloguePolicyDto; readonly onChanged: () => void; readonly onClose: () => void;
}): React.ReactElement {
  const [role, setRole] = useState<CatalogueRoleDetailDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [synonym, setSynonym] = useState({ synonym: '', reasonCode: '' });
  const [dialog, setDialog] = useState<null | { readonly kind: 'draft' } | { readonly kind: 'transition'; readonly set: RequirementSetDto; readonly toState: CareerRequirementSetState }
    | { readonly kind: 'removeSynonym'; readonly synonymId: string; readonly text: string } | { readonly kind: 'publish'; readonly set: RequirementSetDto; readonly releaseLabel: string }>(null);
  const [publishLabel, setPublishLabel] = useState('SELECTABLE');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setRole(null);
    getCatalogueRole(token, roleId, controller.signal)
      .then((result) => { setRole(result.role); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this role.')); });
    return () => controller.abort();
  }, [token, roleId]);

  const apply = (updated: CatalogueRoleDetailDto, message = ''): void => { setRole(updated); setError(''); setNotice(message); onChanged(); };

  if (!role) {
    return <section className="role-card role-wide" aria-label="Catalogue role"><h2>Role</h2>
      {error ? <p className="form-error" role="alert">{error}</p> : <p>Loading role…</p>}
      <button type="button" className="secondary" onClick={onClose}>Close</button></section>;
  }

  const submitSynonym = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!synonym.reasonCode || synonym.synonym.trim().length < 2) { setError('Write the synonym and choose a reason code.'); return; }
    setBusy(true);
    try {
      apply((await addCareerRoleSynonym(token, role.id, { synonym: synonym.synonym.trim(), reasonCode: synonym.reasonCode })).role, 'Synonym added.');
      setSynonym({ synonym: '', reasonCode: '' });
    } catch (cause) {
      setError(formatApiError(cause, 'The synonym could not be added.'));
    } finally { setBusy(false); }
  };

  const open = role.requirementSets.find((set) => set.state === 'DRAFT' || set.state === 'IN_REVIEW' || set.state === 'REVIEWED') ?? null;
  const viewerId = policy.viewer.userId;
  const code = role.catalogueCode ?? role.code;

  return <section className="role-card role-wide" aria-label={`Catalogue role ${code}`}>
    <div className="role-section-title"><h2>{code} · {role.title}</h2><button type="button" className="secondary" onClick={onClose}>Close role</button></div>
    <dl>
      <div><dt>Catalogue name</dt><dd>{role.catalogueTitle ?? 'NA'}</dd></div>
      <div><dt>Starter code</dt><dd>{role.origin === 'STARTER' ? role.code : 'NA (catalogue role)'}</dd></div>
      <div><dt>Family</dt><dd>{role.catalogueFamily ? `${role.catalogueFamily} · ${role.family}` : role.family}</dd></div>
      <div><dt>Typical branches</dt><dd>{role.eligibleBranches.length ? role.eligibleBranches.join(', ') : 'NA'}</dd></div>
      <div><dt>Core skill areas (draft)</dt><dd>{role.coreSkillAreas ?? 'NA'}</dd></div>
      <div><dt>Main evidence</dt><dd>{role.mainEvidence ?? 'NA'}</dd></div>
      <div><dt>Plan</dt><dd>{plannedText(role.plannedRelease)}</dd></div>
      <div><dt>Label</dt><dd><StatusBadge label={releaseLabelText(role.releaseLabel)} tone={role.releaseLabel === 'VERIFIED' ? 'success' : 'neutral'} /></dd></div>
      <div><dt>Students targeting it</dt><dd>{role.liveTargetCount}</dd></div>
    </dl>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    <h3>Synonyms</h3>
    {role.synonyms.length ? <ul className="role-check-list">{role.synonyms.map((entry) => <li key={entry.id}>{entry.synonym} <small>({entry.reasonCode})</small>
      {policy.viewer.manage ? <> <button type="button" className="secondary" onClick={() => setDialog({ kind: 'removeSynonym', synonymId: entry.id, text: entry.synonym })}>Remove {entry.synonym}…</button></> : null}</li>)}</ul>
      : <p>No synonyms yet. Add the words students use for this role.</p>}
    {policy.viewer.manage ? <form onSubmit={(event) => void submitSynonym(event)} noValidate aria-label="Add a synonym">
      <label><span>Synonym</span><input value={synonym.synonym} maxLength={120} onChange={(event) => setSynonym({ ...synonym, synonym: event.target.value })} /></label>
      <label><span>Reason code <em>required</em></span>
        <select value={synonym.reasonCode} onChange={(event) => setSynonym({ ...synonym, reasonCode: event.target.value })}>
          <option value="">Choose a reason…</option>
          {policy.reasons.synonymAdd.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select></label>
      <button type="submit" disabled={busy || !synonym.reasonCode || synonym.synonym.trim().length < 2}>Add synonym</button>
    </form> : null}

    <h3>Live requirements</h3>
    <p><small>What students&apos; gaps are measured against today.{role.liveRequirements.length && !role.requirementSets.some((set) => set.state === 'PUBLISHED') ? ' Written by the starter seed; not yet versioned.' : ''}</small></p>
    <RequirementTable items={role.liveRequirements} empty="No live requirements. Students targeting this role see every requirement as unknown, never as weak." />

    <h3>Requirement sets</h3>
    {!open && policy.viewer.manage ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'draft' })}>Start a new draft…</button> : null}
    {role.requirementSets.length ? role.requirementSets.map((set) => <article key={set.id} className="role-card" aria-label={`Requirement set v${set.version}`}>
      <div className="role-section-title"><h4>Version {set.version}</h4><StatusBadge label={label(set.state)} tone={setTone(set.state)} /></div>
      <p><small>Drafted by {set.author.email} ({set.reasonCode}, from {set.basedOn === 'LIVE' ? 'the live requirements' : set.basedOn === 'SET' ? 'the published set' : 'nothing'}) · {when(set.createdAt)}
        {set.reviewer ? ` · reviewed by ${set.reviewer.email}` : ''}{set.publishedAt ? ` · published ${when(set.publishedAt)} as ${releaseLabelText(set.releaseLabelAtPublish)}` : ''}</small></p>
      {set.reviewReasonCode && set.state !== 'PUBLISHED' && set.state !== 'SUPERSEDED' ? <p>Last review: {set.reviewReasonCode}{set.reviewNote ? ` — ${set.reviewNote}` : ''}</p> : null}
      {set.state === 'DRAFT' && policy.viewer.manage
        ? <RequirementEditor token={token} set={set} policy={policy} onSaved={(updated) => apply(updated, 'Draft saved.')} />
        : <RequirementTable items={set.items} empty="No requirements in this set." />}
      <div className="role-actions">
        {set.state === 'DRAFT' && policy.viewer.manage ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', set, toState: 'IN_REVIEW' })}>Submit for review…</button> : null}
        {set.state === 'IN_REVIEW' && policy.viewer.review && set.author.userId !== viewerId ? <>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', set, toState: 'REVIEWED' })}>Pass review…</button>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', set, toState: 'DRAFT' })}>Send back…</button></> : null}
        {set.state === 'IN_REVIEW' && set.author.userId === viewerId ? <small>You drafted this set, so someone else reviews it.</small> : null}
        {set.state === 'REVIEWED' && policy.viewer.publish ? <>
          <label className="role-local-search"><span>Label after publishing</span>
            <select aria-label="Label after publishing" value={publishLabel} onChange={(event) => setPublishLabel(event.target.value)}>
              {policy.releaseLabels.map((value) => <option key={value} value={value}>{releaseLabelText(value)}</option>)}
            </select></label>
          <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: 'publish', set, releaseLabel: publishLabel })}>Request publish…</button></> : null}
        {(set.state === 'DRAFT' || set.state === 'IN_REVIEW' || set.state === 'REVIEWED') && policy.viewer.manage
          ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', set, toState: 'WITHDRAWN' })}>Withdraw…</button> : null}
      </div>
    </article>) : <p>No requirement set yet.</p>}

    {dialog?.kind === 'draft' ? <ReasonDialog title={`Start a new draft for ${code}`} approvalNote="Not required: a draft changes nothing students see."
      reasons={policy.reasons.draftCreate} submitLabel="Start draft" withNote={false} onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await createCareerRequirementDraft(token, role.id, { reasonCode })).role, 'Draft started.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'removeSynonym' ? <ReasonDialog title={`Remove the synonym "${dialog.text}"`} approvalNote="Not required: recorded with your reason."
      reasons={policy.reasons.synonymRemove} submitLabel="Remove" withNote={false} onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await removeCareerRoleSynonym(token, role.id, dialog.synonymId, { reasonCode })).role, 'Synonym removed.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'transition' ? <ReasonDialog title={transitionTitle(dialog.toState, dialog.set.version)}
      approvalNote={dialog.toState === 'REVIEWED' ? 'Not required to review. Publishing afterwards needs Content Publish and a second person\'s approval.' : 'Not required: recorded with your reason.'}
      reasons={(policy.reasons.transition[dialog.toState] ?? []).filter((reason) => dialog.toState !== 'DRAFT' || (reason === 'AUTHOR_RECALL') === (dialog.set.author.userId === viewerId))}
      submitLabel={transitionTitle(dialog.toState, dialog.set.version)} withNote onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode, note) => {
        apply((await transitionCareerRequirementSet(token, dialog.set.id, { toState: dialog.toState, reasonCode, ...(note ? { note } : {}) })).role, `Version ${dialog.set.version}: ${label(dialog.toState)}.`);
        setDialog(null);
      }} /> : null}
    {dialog?.kind === 'publish' ? <RequestApprovalDialog token={token} actionKey="CAREER_REQUIREMENT_SET_PUBLISH"
      payload={{ setId: dialog.set.id, releaseLabel: dialog.releaseLabel }} reasons={policy.reasons.publish}
      title={`Publish version ${dialog.set.version} of ${code}`}
      details={[['Role', `${code} · ${role.title}`], ['Requirements', String(dialog.set.items.length)], ['Label after publishing', releaseLabelText(dialog.releaseLabel)],
        ['Effect', 'Replaces the live requirements every student\'s gap for this role is measured against.']]}
      onCancel={() => setDialog(null)} onFiled={(message) => { setDialog(null); setNotice(message); }} /> : null}
  </section>;
}

function transitionTitle(toState: CareerRequirementSetState, version: number): string {
  switch (toState) {
    case 'IN_REVIEW': return `Submit version ${version} for review`;
    case 'REVIEWED': return `Pass review of version ${version}`;
    case 'DRAFT': return `Send version ${version} back to draft`;
    case 'WITHDRAWN': return `Withdraw version ${version}`;
    default: return `Move version ${version}`;
  }
}

function RequirementTable({ items, empty }: { readonly items: readonly RequirementItemDto[]; readonly empty: string }): React.ReactElement {
  if (!items.length) return <p>{empty}</p>;
  return <div className="role-record-table-wrap"><table className="role-record-table">
    <thead><tr><th>Topic</th><th>Level</th><th>Target depth</th><th>Required evidence</th><th>Rationale</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.topicId}>
      <td>{item.topicTitle ?? 'NA'}{item.topicKey ? <><br /><small>{item.topicKey}</small></> : null}</td>
      <td>{label(item.requirementLevel)}</td>
      <td>{item.targetMastery.toFixed(2)}</td>
      <td>{item.requiredEvidenceTypes.length ? item.requiredEvidenceTypes.map(label).join(', ') : 'None'}</td>
      <td>{item.rationale ?? 'NA'}</td>
    </tr>)}</tbody></table></div>;
}

interface EditableItem { topicId: string; topicTitle: string; requirementLevel: CareerRequirementLevel; targetMastery: string; rationale: string; requiredEvidenceTypes: string[] }

function RequirementEditor({ token, set, policy, onSaved }: {
  readonly token: string; readonly set: RequirementSetDto; readonly policy: CareerCataloguePolicyDto; readonly onSaved: (role: CatalogueRoleDetailDto) => void;
}): React.ReactElement {
  const [items, setItems] = useState<EditableItem[]>(() => set.items.map((item) => ({
    topicId: item.topicId, topicTitle: item.topicTitle ?? item.topicKey ?? 'NA', requirementLevel: item.requirementLevel,
    targetMastery: String(item.targetMastery), rationale: item.rationale ?? '', requiredEvidenceTypes: [...item.requiredEvidenceTypes],
  })));
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<readonly { readonly id: string; readonly stableKey: string; readonly name: string }[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (index: number, change: Partial<EditableItem>): void => setItems((current) => current.map((item, at) => (at === index ? { ...item, ...change } : item)));
  const valid = items.every((item) => { const value = Number(item.targetMastery); return value > 0 && value <= 1; });

  const search = async (): Promise<void> => {
    try { setFound((await searchCatalogueTopics(token, query.trim())).topics); setError(''); } catch (cause) { setError(formatApiError(cause, 'Topics could not be searched.')); }
  };
  const save = async (): Promise<void> => {
    if (!valid) { setError('Each target depth is a proportion above 0 and at most 1.'); return; }
    setBusy(true);
    try {
      const result = await saveCareerRequirementItems(token, set.id, {
        reasonCode: policy.reasons.itemsSave[0] ?? 'DRAFT_EDIT',
        items: items.map((item) => ({
          topicId: item.topicId, requirementLevel: item.requirementLevel, targetMastery: Math.round(Number(item.targetMastery) * 1000) / 1000,
          ...(item.rationale.trim() ? { rationale: item.rationale.trim() } : {}), requiredEvidenceTypes: item.requiredEvidenceTypes,
        })),
      });
      onSaved(result.role);
    } catch (cause) {
      setError(formatApiError(cause, 'The draft could not be saved.'));
    } finally { setBusy(false); }
  };

  return <div aria-label={`Edit version ${set.version}`}>
    {items.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Topic</th><th>Level</th><th>Target depth (0–1)</th><th>Required evidence</th><th>Rationale</th><th /></tr></thead>
      <tbody>{items.map((item, index) => <tr key={item.topicId}>
        <td>{item.topicTitle}</td>
        <td><select aria-label={`Level for ${item.topicTitle}`} value={item.requirementLevel} onChange={(event) => update(index, { requirementLevel: event.target.value as CareerRequirementLevel })}>
          {policy.requirementLevels.map((level) => <option key={level} value={level}>{label(level)}</option>)}</select></td>
        <td><input aria-label={`Target depth for ${item.topicTitle}`} inputMode="decimal" value={item.targetMastery} onChange={(event) => update(index, { targetMastery: event.target.value })} /></td>
        <td>{policy.evidenceTypes.map((type) => <label key={type}><input type="checkbox" checked={item.requiredEvidenceTypes.includes(type)}
          onChange={(event) => update(index, { requiredEvidenceTypes: event.target.checked ? [...item.requiredEvidenceTypes, type] : item.requiredEvidenceTypes.filter((entry) => entry !== type) })} /> {label(type)}</label>)}</td>
        <td><input aria-label={`Rationale for ${item.topicTitle}`} value={item.rationale} maxLength={500} onChange={(event) => update(index, { rationale: event.target.value })} /></td>
        <td><button type="button" className="secondary" onClick={() => setItems((current) => current.filter((_, at) => at !== index))}>Remove {item.topicTitle}</button></td>
      </tr>)}</tbody></table></div> : <p>This draft has no requirements yet. Add topics below.</p>}
    <div className="role-actions">
      <label className="role-local-search"><span>Find a topic</span><input value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} /></label>
      <button type="button" className="secondary" onClick={() => void search()}>Find topics</button>
    </div>
    {found && !found.length ? <p>No active topic matches. Requirements can only name topics that exist in the published taxonomy.</p> : null}
    {found?.length ? <ul className="role-check-list">{found.filter((topic) => !items.some((item) => item.topicId === topic.id)).map((topic) => <li key={topic.id}>
      {topic.name} <small>{topic.stableKey}</small> <button type="button" className="secondary"
        onClick={() => setItems((current) => [...current, { topicId: topic.id, topicTitle: topic.name, requirementLevel: 'IMPORTANT', targetMastery: '0.6', rationale: '', requiredEvidenceTypes: [] }])}>Add {topic.name}</button></li>)}</ul> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button type="button" disabled={busy || !valid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save draft'}</button>
  </div>;
}

/** The confirm dialog for routine catalogue writes: a reason code is required. */
function ReasonDialog({ title, approvalNote, reasons, submitLabel, withNote, onCancel, onSubmit }: {
  readonly title: string; readonly approvalNote: string; readonly reasons: readonly string[]; readonly submitLabel: string; readonly withNote: boolean;
  readonly onCancel: () => void; readonly onSubmit: (reasonCode: string, note: string | null) => Promise<void>;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      await onSubmit(reasonCode, note.trim() ? note.trim() : null);
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be saved.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="catalogue-dialog-title">
      <h2 id="catalogue-dialog-title">{title}</h2>
      <dl><div><dt>Approval</dt><dd>{approvalNote}</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {withNote ? <label><span>Note (optional, {noteLimit} characters) — do not include personal data</span>
          <textarea value={note} maxLength={noteLimit} onChange={(event) => setNote(event.target.value)} /></label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </form>
    </section>
  </div>;
}
