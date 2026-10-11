/**
 * ONE · Role portal — Operations Content Management: the skill map editor (OPS-09a).
 *
 * Lives under the existing Content Management label (Appendix 1 §4.2), below the job-role
 * catalogue; no navigation item is added. Operators draft a skill (what it looks like at the
 * aware, guided, independent and troubleshoot levels, which skills come first, and the rights
 * its text is under), a different person reviews it — approving is also the rights review —
 * and someone who wrote none of it publishes it. A publish that changes what students are
 * measured against files an approval request instead (Settings → Approvals).
 *
 * The server decides everything: capabilities, reason codes, who wrote a revision, and whether
 * a publish needs an approval. Levels are descriptors, never numbers. A missing value hides its
 * row, or reads in plain words where a column must stay.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  createSkill,
  getProtectedAccessToken,
  getSkill,
  getSkillMapPolicy,
  listSkills,
  publishSkillRevision,
  saveSkillDraft,
  archiveSkill,
  startSkillRevision,
  transitionSkillRevision,
} from '../api.js';
import type { SkillDetailDto, SkillLevel, SkillListDto, SkillMapPolicyDto, SkillRevisionDto, SkillRevisionState, SkillSummaryDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError } from './shared.js';
import { SupportCode } from '../supportCode.js';
import { formatDateTime } from '../dates.js';
import { MISSING_TEXT, codeLabel } from '../labels.js';

const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
const when = (value: string | null | undefined): string => (value ? formatDateTime(value) : MISSING_TEXT);
const statusText = (status: string): string => (status === 'LIVE' ? 'Live' : status === 'PENDING' ? 'Not yet published' : status === 'RETIRED' ? 'Retired' : 'Unknown');
const statusTone = (status: string): 'success' | 'warning' | 'neutral' | 'info' => (status === 'LIVE' ? 'success' : status === 'PENDING' ? 'warning' : 'neutral');
const stateTone = (state: SkillRevisionState): 'success' | 'warning' | 'neutral' | 'info' =>
  state === 'PUBLISHED' ? 'success' : state === 'IN_REVIEW' || state === 'APPROVED' ? 'warning' : state === 'DRAFT' || state === 'CHANGES_REQUESTED' ? 'info' : 'neutral';
const filters = [
  { value: '', text: 'All skills' }, { value: 'LIVE', text: 'Live' }, { value: 'PENDING', text: 'Not yet published' },
  { value: 'AWAITING_REVIEW', text: 'Awaiting review' }, { value: 'CHANGES_REQUESTED', text: 'Changes requested' },
  { value: 'AWAITING_PUBLISH', text: 'Approved, awaiting publish' }, { value: 'RETIRED', text: 'Retired' },
];

export function OperationsSkillMapPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [policy, setPolicy] = useState<SkillMapPolicyDto | null>(null);
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [draftFilters, setDraftFilters] = useState({ q: '', filter: '' });
  const [applied, setApplied] = useState(draftFilters);
  const [list, setList] = useState<SkillListDto | null>(null);
  const [more, setMore] = useState<readonly SkillSummaryDto[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getSkillMapPolicy(token, controller.signal)
      .then((result) => { setPolicy(result); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the skill map policy.'));
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || forbiddenReference) return;
    const controller = new AbortController();
    setLoading(true);
    listSkills(token, applied, null, controller.signal)
      .then((result) => { setList(result); setMore([]); setMoreCursor(null); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the skill map.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, applied, reload, forbiddenReference]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Content Management</span><h1>Skill map</h1>
    <p>The skills roles are measured on: what each looks like when a learner is aware of it, can do it guided, can do it independently, and can troubleshoot it, and which skills come first. A skill is drafted, reviewed by someone who did not write it (including its rights), and published by someone who wrote none of it. A skill goes live only once published.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="The skill map is for staff who hold Content Edit, Content Review, Content Publish or Catalogue Manage. Your access has not changed; the rest of Content Management is unaffected."
        hint={<SupportCode reference={forbiddenReference} />} /></div></section>;
  }

  const skills = [...(list?.skills ?? []), ...more];
  const nextCursor = more.length ? moreCursor : list?.nextCursor ?? null;
  const summary = list?.summary;
  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await listSkills(token, applied, nextCursor);
      setMoreCursor(page.nextCursor);
      setMore((current) => [...current, ...page.skills]);
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to load more skills.'));
    }
  };

  return <section className="role-module role-module--dense" aria-label="Skill map">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🧩" tone="teal" value={summary ? summary.live : null} label="Live skills" />
      <V2Stat icon="📝" tone="purple" value={summary ? summary.pending : null} label="Not yet published" />
      <V2Stat icon="🔍" tone="amber" value={summary ? summary.awaitingReview : null} label="Awaiting review" />
      <V2Stat icon="🚀" tone="blue" value={summary ? summary.awaitingPublish : null} label="Approved, awaiting publish" />
    </div>
    {summary && summary.agentDraftedPending > 0 ? <p role="note">{summary.agentDraftedPending} unpublished skills were drafted by the coding agent. Each needs its levels written and checked against its basis before review.</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-card role-wide"><div className="role-section-title"><h2>Skills</h2>
      {policy?.viewer.edit ? <button type="button" className="secondary" onClick={() => setCreating(true)}>New skill…</button> : null}</div>
      <form className="role-actions" aria-label="Search the skill map" onSubmit={(event) => { event.preventDefault(); setApplied(draftFilters); }}>
        <label className="role-local-search"><span>Search</span>
          <input value={draftFilters.q} maxLength={120} placeholder="Name or key" onChange={(event) => setDraftFilters({ ...draftFilters, q: event.target.value })} /></label>
        <label className="role-local-search"><span>Show</span>
          <select aria-label="Skill filter" value={draftFilters.filter} onChange={(event) => setDraftFilters({ ...draftFilters, filter: event.target.value })}>
            {filters.map((entry) => <option key={entry.value} value={entry.value}>{entry.text}</option>)}
          </select></label>
        <button type="submit" className="pilot-btn">Search</button>
      </form>
      {loading && !list ? <p>Loading the skill map…</p> : null}
      {!loading && list && !skills.length ? <V2EmptyState icon="🔎" title="No skills match" note="No skill matches this search. Skills appear here once drafted in this editor or imported as drafts." /> : null}
      {skills.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Key</th><th>Skill</th><th>Status</th><th>Published</th><th>Revision on its way</th><th>Prerequisites</th><th>Levels</th><th>Live requirements</th><th>Actions</th></tr></thead>
        <tbody>{skills.map((skill) => <tr key={skill.topicId}>
          <td><strong>{skill.stableKey}</strong>{skill.source === 'AGENT_DRAFTED' ? <><br /><StatusBadge label="Agent-drafted" tone="warning" /></> : null}</td>
          <td>{skill.name}</td>
          <td><StatusBadge label={statusText(skill.status)} tone={statusTone(skill.status)} /></td>
          <td>{skill.publishedRevision ? `Revision ${skill.publishedRevision}` : 'Not published'}</td>
          <td>{skill.openRevision ? `Revision ${skill.openRevision.revision} · ${label(skill.openRevision.state)}` : 'None'}</td>
          <td>{skill.prerequisites.length ? skill.prerequisites.join(', ') : 'None'}</td>
          <td>{skill.levelsComplete ? 'All four described' : 'Incomplete'}</td>
          <td>{skill.liveRequirementCount}</td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(skill.topicId)}>Open {skill.stableKey}</button></td>
        </tr>)}</tbody></table></div> : null}
      {nextCursor ? <button type="button" className="secondary" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
    {selectedId && policy ? <SkillPanel token={token} topicId={selectedId} policy={policy}
      onChanged={() => setReload((value) => value + 1)} onClose={() => setSelectedId('')} /> : null}
    {creating && policy ? <CreateSkillDialog token={token} policy={policy} onCancel={() => setCreating(false)}
      onCreated={(skill) => { setCreating(false); setSelectedId(skill.topicId); setReload((value) => value + 1); }} /> : null}
  </section>;
}

type Dialog =
  | { readonly kind: 'revise' }
  | { readonly kind: 'archive' }
  | { readonly kind: 'transition'; readonly revision: SkillRevisionDto; readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' }
  | { readonly kind: 'publish'; readonly revision: SkillRevisionDto }
  | { readonly kind: 'publishWithApproval'; readonly revision: SkillRevisionDto };

function SkillPanel({ token, topicId, policy, onChanged, onClose }: {
  readonly token: string; readonly topicId: string; readonly policy: SkillMapPolicyDto; readonly onChanged: () => void; readonly onClose: () => void;
}): React.ReactElement {
  const [skill, setSkill] = useState<SkillDetailDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSkill(null);
    getSkill(token, topicId, controller.signal)
      .then((result) => { setSkill(result.skill); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this skill.')); });
    return () => controller.abort();
  }, [token, topicId]);

  const apply = (updated: SkillDetailDto, message = ''): void => { setSkill(updated); setError(''); setNotice(message); onChanged(); };

  if (!skill) {
    return <section className="role-card role-wide" aria-label="Skill"><h2>Skill</h2>
      {error ? <p className="form-error" role="alert">{error}</p> : <p>Loading skill…</p>}
      <button type="button" className="secondary" onClick={onClose}>Close</button></section>;
  }

  // The revision on its way: the separate open one for a live skill, or the draft itself for a pending one.
  const working = skill.open ?? (skill.current.state !== 'PUBLISHED' && skill.current.state !== 'ARCHIVED' ? skill.current : null);
  const viewerId = policy.viewer.userId;
  const wroteIt = working ? working.contributors.some((entry) => entry.userId === viewerId) : false;
  const editable = working && (working.state === 'DRAFT' || working.state === 'CHANGES_REQUESTED');

  return <section className="role-card role-wide" aria-label={`Skill ${skill.stableKey}`}>
    <div className="role-section-title"><h2>{skill.name}</h2><button type="button" className="secondary" onClick={onClose}>Close skill</button></div>
    <dl>
      <div><dt>Key</dt><dd>{skill.stableKey}</dd></div>
      <div><dt>Status</dt><dd><StatusBadge label={statusText(skill.status)} tone={statusTone(skill.status)} /></dd></div>
      {skill.publishedRevision !== null && skill.publishedRevision !== undefined ? <div><dt>Published revision</dt><dd>{skill.publishedRevision}</dd></div> : null}
      <div><dt>Written by</dt><dd>{skill.source === 'AGENT_DRAFTED'
        ? `The coding agent (${[skill.provenance.generatorVersion, skill.provenance.promptVersion, when(skill.provenance.generatedAt)].filter((entry) => entry && entry !== MISSING_TEXT).join(', ')}) — check it against its basis`
        : 'A person, in this editor or a seed'}</dd></div>
      <div><dt>Required by</dt><dd>{skill.requiredBy.length ? skill.requiredBy.map((entry) => `${entry.catalogueCode ?? entry.roleTitle} (${label(entry.level)})`).join(', ') : 'No live requirement'}</dd></div>
      <div><dt>Draft requirement sets naming it</dt><dd>{skill.openSetCount}</dd></div>
      <div><dt>Skills that build on it</dt><dd>{skill.dependents.length ? skill.dependents.map((entry) => entry.stableKey).join(', ') : 'None'}</dd></div>
    </dl>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    {skill.current.state === 'PUBLISHED' ? <><h3>Published — revision {skill.current.revision}</h3><RevisionView revision={skill.current} policy={policy} skill={skill} /></> : null}
    {!working && skill.status === 'LIVE' && policy.viewer.edit
      ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'revise' })}>Start a new revision…</button> : null}
    {!working && skill.status === 'LIVE' && policy.viewer.publish && policy.reasons.archive
      ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'archive' })}>Archive…</button> : null}

    {working ? <article className="role-card" aria-label={`Revision ${working.revision}`}>
      <div className="role-section-title"><h3>Revision {working.revision}</h3><StatusBadge label={label(working.state)} tone={stateTone(working.state)} /></div>
      <p><small>Author {working.author.email} · started {when(working.createdAt)}{working.contributors.length > 1 ? ` · edited by ${working.contributors.filter((entry) => entry.userId !== working.author.userId).map((entry) => entry.email).join(', ')}` : ''}</small></p>
      {editable && policy.viewer.edit
        ? <SkillEditor token={token} revision={working} policy={policy} onSaved={(updated) => apply(updated, 'Draft saved.')} />
        : <RevisionView revision={working} policy={policy} skill={skill} />}
      <div className="role-actions">
        {editable && policy.viewer.edit ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'IN_REVIEW' })}>Submit for review…</button> : null}
        {working.state === 'IN_REVIEW' && policy.viewer.review && !wroteIt ? <>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'APPROVED' })}>Approve, with rights review…</button>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'CHANGES_REQUESTED' })}>Request changes…</button></> : null}
        {working.state === 'APPROVED' && policy.viewer.publish && !wroteIt
          ? <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: skill.publishNeedsApproval ? 'publishWithApproval' : 'publish', revision: working })}>
            {skill.publishNeedsApproval ? 'Request publish…' : 'Publish…'}</button> : null}
        {wroteIt && (working.state === 'IN_REVIEW' || working.state === 'APPROVED') ? <small>You wrote or edited this revision, so someone else reviews and publishes it.</small> : null}
      </div>
    </article> : null}

    <h3>History</h3>
    {skill.history.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>When</th><th>Revision</th><th>Action</th><th>Move</th><th>Reason</th><th>By</th></tr></thead>
      <tbody>{skill.history.map((entry, index) => <tr key={`${entry.occurredAt}-${index}`}>
        <td>{when(entry.occurredAt)}</td><td>{entry.revision}</td><td>{label(entry.action)}</td>
        <td>{label(entry.fromState)} → {label(entry.toState)}</td><td>{codeLabel(entry.reasonCode)}</td><td>{entry.actorEmail}</td>
      </tr>)}</tbody></table></div> : <p>No review actions yet.</p>}

    {dialog?.kind === 'archive' ? <ReasonDialog title={`Archive ${skill.stableKey}`}
      approvalNote="Not required: archiving removes the skill, so no second person approves it, but it is recorded with your reason. The skill is retired at once and is never deleted; evidence already recorded against it stays. It is refused while a role requires it, a live skill needs it first, or a live question or lesson is on it."
      reasons={policy.reasons.archive ?? []} submitLabel="Archive skill" onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await archiveSkill(token, skill.topicId, { reasonCode })).skill, 'Archived: the skill is retired.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'revise' ? <ReasonDialog title={`Start revision of ${skill.stableKey}`} approvalNote="Not required: a new revision changes nothing until it is published."
      reasons={policy.reasons.revise} submitLabel="Start revision" onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await startSkillRevision(token, skill.topicId, { reasonCode })).skill, 'Revision started.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'transition' ? <ReasonDialog title={transitionTitle(dialog.toState, dialog.revision.revision)}
      approvalNote={dialog.toState === 'APPROVED'
        ? `Not required to approve. Approving also records your rights review of the ${dialog.revision.fields.licenceLabel ? `${dialog.revision.fields.licenceLabel} ` : ''}licence the author declared.`
        : 'Not required: recorded with your reason.'}
      reasons={policy.reasons.transition[dialog.toState] ?? []}
      rightsReasons={dialog.toState === 'APPROVED' ? policy.reasons.rights : null}
      submitLabel={transitionTitle(dialog.toState, dialog.revision.revision)} withNote onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode, note, rightsReasonCode) => {
        apply((await transitionSkillRevision(token, dialog.revision.id, {
          toState: dialog.toState, reasonCode, ...(rightsReasonCode ? { rightsReasonCode } : {}), ...(note ? { note } : {}),
        })).skill, `Revision ${dialog.revision.revision}: ${label(dialog.toState)}.`);
        setDialog(null);
      }} /> : null}
    {dialog?.kind === 'publish' ? <ReasonDialog title={`Publish revision ${dialog.revision.revision} of ${skill.stableKey}`}
      approvalNote="Not required: no live requirement names this skill and it is already live, so students' measures do not change."
      reasons={policy.reasons.publish} submitLabel="Publish" onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await publishSkillRevision(token, dialog.revision.id, { reasonCode })).skill, 'Published.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'publishWithApproval' ? <RequestApprovalDialog token={token} actionKey="CONTENT_SKILL_PUBLISH"
      payload={{ revisionId: dialog.revision.id }} reasons={policy.reasons.publish}
      title={`Publish revision ${dialog.revision.revision} of ${skill.stableKey}`}
      details={[['Skill', `${skill.name} (${skill.stableKey})`],
        ['Effect', skill.status === 'LIVE'
          ? skill.requiredBy.length ? `Changes a skill live requirements name (${skill.requiredBy.map((entry) => entry.catalogueCode ?? entry.roleTitle).join(', ')}).` : 'Changes a live skill; no live requirement names it yet.'
          : 'Makes the skill live: evidence can be recorded against it and requirement sets naming it can be published.']]}
      onCancel={() => setDialog(null)} onFiled={(message) => { setDialog(null); setNotice(message); }} /> : null}
  </section>;
}

function transitionTitle(toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED', revision: number): string {
  switch (toState) {
    case 'IN_REVIEW': return `Submit revision ${revision} for review`;
    case 'CHANGES_REQUESTED': return `Request changes to revision ${revision}`;
    case 'APPROVED': return `Approve revision ${revision}`;
  }
}

function RevisionView({ revision, policy, skill }: { readonly revision: SkillRevisionDto; readonly policy: SkillMapPolicyDto; readonly skill: SkillDetailDto }): React.ReactElement {
  const fields = revision.fields;
  const prerequisiteStatus = new Map(skill.prerequisiteSkills.map((entry) => [entry.stableKey, entry.status]));
  return <div>
    {fields.description ? <p>{fields.description}</p> : null}
    <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Level</th><th>What a learner can do</th></tr></thead>
      <tbody>{policy.levels.map((entry) => <tr key={entry.level}><td>{label(entry.level)}<br /><small>{entry.meaning}</small></td><td>{fields.levels[entry.level] || 'Not written yet'}</td></tr>)}</tbody>
    </table></div>
    <dl>
      <div><dt>Prerequisites</dt><dd>{fields.prerequisites.length ? fields.prerequisites.map((key) => {
        const status = prerequisiteStatus.get(key);
        return `${key}${status && status !== 'LIVE' ? ` (${statusText(status).toLowerCase()})` : ''}`;
      }).join(', ') : 'None'}</dd></div>
      {fields.licenceLabel || fields.attribution ? <div><dt>Licence</dt><dd>{fields.licenceLabel ?? MISSING_TEXT}{fields.attribution ? ` — ${fields.attribution}` : ''}</dd></div> : null}
      {fields.basis ? <div><dt>Basis</dt><dd>{fields.basis}</dd></div> : null}
      {revision.expertCheck ? <div><dt>For the subject expert</dt><dd>{revision.expertCheck}</dd></div> : null}
      <div><dt>Rights review</dt><dd>{revision.rightsReview
        ? `${revision.rightsReview.licenceLabel} confirmed by ${revision.rightsReview.reviewerEmail} (${revision.rightsReview.reasonCode}) · ${when(revision.rightsReview.reviewedAt)}`
        : 'Not yet reviewed'}</dd></div>
    </dl>
  </div>;
}

function SkillEditor({ token, revision, policy, onSaved }: {
  readonly token: string; readonly revision: SkillRevisionDto; readonly policy: SkillMapPolicyDto; readonly onSaved: (skill: SkillDetailDto) => void;
}): React.ReactElement {
  const [fields, setFields] = useState(() => ({
    name: revision.fields.name, description: revision.fields.description, levels: { ...revision.fields.levels } as Record<SkillLevel, string>,
    prerequisites: revision.fields.prerequisites.join(', '), licenceLabel: revision.fields.licenceLabel ?? '',
    attribution: revision.fields.attribution ?? '', basis: revision.fields.basis ?? '',
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const licence = policy.licences.find((entry) => entry.licence === fields.licenceLabel);
  const levelsDone = policy.levels.filter((entry) => fields.levels[entry.level]?.trim()).length;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const prerequisites = fields.prerequisites.split(',').map((key) => key.trim()).filter(Boolean);
      const result = await saveSkillDraft(token, revision.id, {
        name: fields.name.trim(), description: fields.description.trim(), levels: fields.levels, prerequisites,
        licenceLabel: fields.licenceLabel || null,
        ...(fields.attribution.trim() ? { attribution: fields.attribution.trim() } : {}),
        ...(fields.basis.trim() ? { basis: fields.basis.trim() } : {}),
        reasonCode: policy.reasons.save[0] ?? 'DRAFT_EDIT',
      });
      onSaved(result.skill);
    } catch (cause) {
      setError(formatApiError(cause, 'The draft could not be saved.'));
    } finally { setBusy(false); }
  };

  return <form aria-label={`Edit revision ${revision.revision}`} noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label><span>Name</span><input value={fields.name} maxLength={policy.limits.name} onChange={(event) => setFields({ ...fields, name: event.target.value })} /></label>
    <label><span>Description</span><textarea value={fields.description} maxLength={policy.limits.description} onChange={(event) => setFields({ ...fields, description: event.target.value })} /></label>
    {policy.levels.map((entry) => <label key={entry.level}><span>{label(entry.level)} — {entry.meaning}</span>
      <textarea aria-label={`${label(entry.level)} level`} value={fields.levels[entry.level] ?? ''} maxLength={policy.limits.level}
        onChange={(event) => setFields({ ...fields, levels: { ...fields.levels, [entry.level]: event.target.value } })} /></label>)}
    <label><span>Prerequisites — skill keys, separated by commas</span>
      <input value={fields.prerequisites} onChange={(event) => setFields({ ...fields, prerequisites: event.target.value })} /></label>
    <label><span>Licence of this text</span>
      <select aria-label="Licence" value={fields.licenceLabel} onChange={(event) => setFields({ ...fields, licenceLabel: event.target.value })}>
        <option value="">Choose a licence…</option>
        {policy.licences.map((entry) => <option key={entry.licence} value={entry.licence}>{entry.licence}</option>)}
      </select></label>
    {licence?.attributionRequired ? <label><span>Attribution (required by this licence)</span>
      <input value={fields.attribution} maxLength={policy.limits.attribution} onChange={(event) => setFields({ ...fields, attribution: event.target.value })} /></label> : null}
    <label><span>Basis — what this rests on (a qualification file, a framework)</span>
      <textarea value={fields.basis} maxLength={policy.limits.basis} onChange={(event) => setFields({ ...fields, basis: event.target.value })} /></label>
    <p><small>Ready for review needs all four levels ({levelsDone} of 4 described) and a licence ({fields.licenceLabel || 'none chosen'}).</small></p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button type="submit" disabled={busy || !fields.name.trim() || !fields.description.trim()}>{busy ? 'Saving…' : 'Save draft'}</button>
  </form>;
}

function CreateSkillDialog({ token, policy, onCancel, onCreated }: {
  readonly token: string; readonly policy: SkillMapPolicyDto; readonly onCancel: () => void; readonly onCreated: (skill: SkillDetailDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ stableKey: '', name: '', description: '', reasonCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyValid = /^[a-z0-9][a-z0-9-]{2,79}$/.test(form.stableKey);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form.reasonCode) { setError('Choose a reason code.'); return; }
    if (!keyValid) { setError('A key is 3 to 80 lower-case letters, digits and hyphens.'); return; }
    setBusy(true);
    try {
      onCreated((await createSkill(token, { ...form, name: form.name.trim(), description: form.description.trim() })).skill);
    } catch (cause) {
      setError(formatApiError(cause, 'The skill could not be created.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="skill-create-title">
      <h2 id="skill-create-title">New skill</h2>
      <dl><div><dt>Approval</dt><dd>Not required: a new skill is a draft that no student or picker sees until it is reviewed and published.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Key <em>required, cannot change later</em></span><input value={form.stableKey} maxLength={80} placeholder="e.g. soc-alert-triage" onChange={(event) => setForm({ ...form, stableKey: event.target.value.trim().toLowerCase() })} /></label>
        <label><span>Name</span><input value={form.name} maxLength={policy.limits.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label><span>Description</span><textarea value={form.description} maxLength={policy.limits.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {policy.reasons.create.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !form.reasonCode || !keyValid || !form.name.trim() || !form.description.trim()}>{busy ? 'Creating…' : 'Create draft'}</button>
        </div>
      </form>
    </section>
  </div>;
}

/** The confirm dialog for skill writes: a reason code is required; approving also asks for the rights reason. */
function ReasonDialog({ title, approvalNote, reasons, rightsReasons = null, submitLabel, withNote = false, onCancel, onSubmit }: {
  readonly title: string; readonly approvalNote: string; readonly reasons: readonly string[]; readonly rightsReasons?: readonly string[] | null;
  readonly submitLabel: string; readonly withNote?: boolean;
  readonly onCancel: () => void; readonly onSubmit: (reasonCode: string, note: string | null, rightsReasonCode: string | null) => Promise<void>;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [rightsReasonCode, setRightsReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const ready = Boolean(reasonCode) && (!rightsReasons || Boolean(rightsReasonCode));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError(rightsReasons ? 'Choose a reason code and a rights reason.' : 'Choose a reason code.'); return; }
    setBusy(true);
    try {
      await onSubmit(reasonCode, note.trim() ? note.trim() : null, rightsReasons ? rightsReasonCode : null);
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be saved.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="skill-dialog-title">
      <h2 id="skill-dialog-title">{title}</h2>
      <dl><div><dt>Approval</dt><dd>{approvalNote}</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {rightsReasons ? <label><span>Rights reason <em>required</em> — you confirm the declared licence is right</span>
          <select aria-label="Rights reason" value={rightsReasonCode} onChange={(event) => setRightsReasonCode(event.target.value)} required>
            <option value="">Choose a rights reason…</option>
            {rightsReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label> : null}
        {withNote ? <label><span>Note (optional, 500 characters) — do not include personal data</span>
          <textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </form>
    </section>
  </div>;
}
