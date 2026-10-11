/**
 * ONE · Role portal — external faculty review (OPS-10, ADR-037).
 *
 * Two screens, both under existing navigation labels (Appendix 1 §4.2; HG-3: nothing added,
 * removed, renamed or reordered):
 *
 * - `OperationsExternalReviewsPage`, under Operations → Content Management below bulk import. A
 *   capability administrator finds a college faculty member by exact email and grants or revokes
 *   faculty review; a content reviewer who did not write a draft assigns in-review drafts to a
 *   granted reviewer for a fixed period, or withdraws an assignment; content staff read every
 *   faculty decision and comment beside the drafts. Every write goes through a dialog that requires
 *   a reason code.
 * - `FacultyContentReviewsPage`, in the institution portal (faculty: Learning Resources; department
 *   head: a section of Assessments). A granted faculty member sees only the drafts assigned to them,
 *   reads an open one (never an answer key), and approves or requests changes with a comment. The
 *   decision is advice to ONE's reviewers; it never publishes anything.
 *
 * The server decides everything. Missing counts read NA; no data is invented.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  assignExternalReviews,
  decideFacultyReview,
  getExternalReviewPolicy,
  getFacultyReview,
  getProtectedAccessToken,
  grantExternalReviewer,
  listExternalReviewAssignments,
  listExternalReviewers,
  listFacultyReviews,
  listReviewableRevisions,
  lookupExternalReviewer,
  revokeExternalReviewer,
  withdrawExternalReview,
} from '../api.js';
import type {
  ExternalReviewAssignmentDto,
  ExternalReviewDecision,
  ExternalReviewerDto,
  ExternalReviewPolicyDto,
  ExternalReviewStatus,
  ExternalReviewSummaryDto,
  FacultyReviewContentDto,
  FacultyReviewDto,
  ReviewableRevisionDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

const statusWords: Readonly<Record<ExternalReviewStatus, { readonly label: string; readonly tone: 'success' | 'warning' | 'neutral' | 'info' | 'danger' }>> = {
  OPEN: { label: 'Open', tone: 'info' },
  DECIDED: { label: 'Decided', tone: 'success' },
  REVOKED: { label: 'Withdrawn', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'warning' },
  CLOSED: { label: 'Closed — the draft moved on', tone: 'neutral' },
};
const decisionWords: Readonly<Record<ExternalReviewDecision, string>> = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes' };
const kindWords: Readonly<Record<string, string>> = { TOPIC: 'Skill', SKILL: 'Skill', QUESTION: 'Question', LESSON: 'Lesson' };
const roleWords: Readonly<Record<string, string>> = { FACULTY_LECTURER: 'Faculty', DEPARTMENT_HEAD: 'Department head' };

/** Plain words for the refusals an operator or reviewer can act on; anything else is the shared message. */
function reviewError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError) {
    const words: Readonly<Record<string, string>> = {
      EXTERNAL_REVIEWER_NOT_ELIGIBLE: 'Only an active college faculty member or department head holding faculty review can be chosen.',
      EXTERNAL_REVIEWER_ALREADY_GRANTED: 'This person already holds faculty review.',
      EXTERNAL_REVIEWER_NOT_GRANTED: 'This person does not hold faculty review.',
      EXTERNAL_REVIEWER_SELF_CHANGE_REFUSED: 'You cannot change your own access.',
      EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED: 'Someone who wrote, edited or submitted this draft cannot choose its reviewer or review it.',
      EXTERNAL_REVIEW_SELF_ASSIGN_REFUSED: 'You cannot assign a draft to yourself.',
      EXTERNAL_REVIEW_ALREADY_ASSIGNED: 'This draft is already assigned to this reviewer.',
      EXTERNAL_REVIEW_REVISION_NOT_IN_REVIEW: 'Only a draft that is in review can be assigned.',
      EXTERNAL_REVIEW_NOT_OPEN: 'This assignment is no longer open.',
      EXTERNAL_REVIEW_EXPIRED: 'This assignment has expired.',
      EXTERNAL_REVIEW_COMMENT_REQUIRED: 'Say what should change.',
      EXTERNAL_REVIEW_WINDOW_INVALID: 'Choose between the allowed number of days.',
    };
    const text = cause.code ? words[cause.code] : undefined;
    if (text) return `${text} Reference: ${cause.correlationId}`;
  }
  return formatApiError(cause, fallback);
}

const day = (value: string): string => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : 'NA';
};

// ---------------------------------------------------------------------------
// Operations: Content Management
// ---------------------------------------------------------------------------

type OpsDialog =
  | { readonly kind: 'grant'; readonly reviewer: ExternalReviewerDto }
  | { readonly kind: 'revoke'; readonly reviewer: ExternalReviewerDto }
  | { readonly kind: 'assign'; readonly revisionIds: readonly string[]; readonly reviewer: ExternalReviewerDto; readonly days: number }
  | { readonly kind: 'withdraw'; readonly assignment: ExternalReviewAssignmentDto };

export function OperationsExternalReviewsPage(): React.ReactElement | null {
  const token = getProtectedAccessToken() ?? '';
  const [policy, setPolicy] = useState<ExternalReviewPolicyDto | null>(null);
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewers, setReviewers] = useState<readonly ExternalReviewerDto[] | null>(null);
  const [summary, setSummary] = useState<ExternalReviewSummaryDto | null>(null);
  const [assignments, setAssignments] = useState<readonly ExternalReviewAssignmentDto[] | null>(null);
  const [revisions, setRevisions] = useState<readonly ReviewableRevisionDto[] | null>(null);
  const [email, setEmail] = useState('');
  const [candidates, setCandidates] = useState<readonly ExternalReviewerDto[] | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [reviewerId, setReviewerId] = useState('');
  const [days, setDays] = useState(14);
  const [dialog, setDialog] = useState<OpsDialog | null>(null);

  const reload = useCallback(async (loaded: ExternalReviewPolicyDto, signal?: AbortSignal): Promise<void> => {
    const [people, list, open] = await Promise.all([
      listExternalReviewers(token, signal),
      listExternalReviewAssignments(token, {}, signal),
      loaded.viewer.assign ? listReviewableRevisions(token, '', signal) : Promise.resolve(null),
    ]);
    setReviewers(people.reviewers);
    setSummary(people.summary);
    setAssignments(list.assignments);
    setRevisions(open ? open.revisions : null);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getExternalReviewPolicy(token, controller.signal)
      .then(async (loaded) => {
        if (!loaded || !loaded.viewer || !loaded.reasons) { setError('Unable to load faculty review.'); return; }
        setPolicy(loaded);
        setDays(loaded.window.default);
        await reload(loaded, controller.signal);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load faculty review.'));
      });
    return () => controller.abort();
  }, [token, reload]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Content Management</span><h1>Faculty review</h1>
    <p>College faculty can review ONE&apos;s drafts as subject experts. A faculty member sees only the drafts assigned to them, for a fixed number of days, never an answer key and never a student. Their decision is advice: a reviewer here still approves the draft and records its rights, and a publisher still publishes it.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="Faculty review is for content staff and capability administrators. Your access has not changed; the rest of Content Management is unaffected."
        hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const granted = (reviewers ?? []).filter((reviewer) => reviewer.grant && reviewer.state === 'ACTIVE');
  const chosenReviewer = granted.find((reviewer) => reviewer.membershipId === reviewerId);

  const findPeople = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice('');
    try {
      const result = await lookupExternalReviewer(token, email.trim());
      setCandidates(result.candidates);
      setError('');
    } catch (cause) {
      setCandidates(null);
      setError(reviewError(cause, 'Unable to look up this email.'));
    }
  };

  const act = async (reasonCode: string): Promise<void> => {
    if (!dialog || !policy) return;
    try {
      if (dialog.kind === 'grant') {
        const result = await grantExternalReviewer(token, dialog.reviewer.membershipId, { reasonCode });
        setNotice(`${result.reviewer.email} can now be assigned drafts to review. Reference: ${result.correlationId}`);
        setCandidates(null);
      } else if (dialog.kind === 'revoke') {
        const result = await revokeExternalReviewer(token, dialog.reviewer.membershipId, { reasonCode });
        setNotice(`Faculty review revoked for ${result.reviewer.email}; ${result.reviewer.closedAssignments} open ${result.reviewer.closedAssignments === 1 ? 'assignment was' : 'assignments were'} withdrawn. Reference: ${result.correlationId}`);
      } else if (dialog.kind === 'assign') {
        const result = await assignExternalReviews(token, { revisionIds: dialog.revisionIds, reviewerMembershipId: dialog.reviewer.membershipId, days: dialog.days, reasonCode });
        setNotice(`Assigned ${result.assignments.length} ${result.assignments.length === 1 ? 'draft' : 'drafts'} to ${dialog.reviewer.email}. Reference: ${result.correlationId}`);
        setSelected([]);
      } else {
        const result = await withdrawExternalReview(token, dialog.assignment.id, reasonCode);
        setNotice(`Assignment withdrawn. Reference: ${result.correlationId}`);
      }
      setDialog(null);
      setError('');
      await reload(policy);
    } catch (cause) {
      setDialog(null);
      setError(reviewError(cause, 'The change could not be saved.'));
    }
  };

  const reasonsFor = (current: OpsDialog): readonly string[] => {
    if (!policy) return [];
    if (current.kind === 'grant') return policy.reasons.grant;
    if (current.kind === 'revoke') return policy.reasons.revoke;
    if (current.kind === 'assign') return policy.reasons.assign;
    return policy.reasons.unassign;
  };

  return <section className="role-module role-module--dense" aria-label="Faculty review">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🎓" tone="teal" value={summary ? summary.reviewers : 'NA'} label="Faculty holding review" />
      <V2Stat icon="📝" tone="blue" value={summary ? summary.open : 'NA'} label="Open assignments" />
      <V2Stat icon="✅" tone="purple" value={summary ? summary.approved : 'NA'} label="Faculty approvals" />
      <V2Stat icon="✏️" tone="amber" value={summary ? summary.changesRequested : 'NA'} label="Changes requested" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!policy && !error ? <p>Loading faculty review…</p> : null}

    {policy ? <section className="role-card role-wide" aria-label="Faculty reviewers"><div className="role-section-title"><h2>Faculty reviewers</h2></div>
      {policy.viewer.administer ? <form className="role-actions" aria-label="Find a faculty member" onSubmit={(event) => void findPeople(event)}>
        <label className="role-local-search"><span>College email, exactly</span>
          <input type="email" aria-label="Faculty email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} /></label>
        <button type="submit" className="pilot-btn" disabled={!email.trim()}>Find</button>
      </form> : null}
      {candidates ? (candidates.length ? <ul aria-label="Matching memberships">{candidates.map((candidate) => <li key={candidate.membershipId}>
        {candidate.email} — {roleWords[candidate.role] ?? candidate.role}, {candidate.institutionName} ({candidate.state.toLowerCase()})
        {candidate.grant ? <> · <StatusBadge label="Holds faculty review" tone="success" /></> : candidate.state === 'ACTIVE'
          ? <> <button type="button" className="secondary" onClick={() => setDialog({ kind: 'grant', reviewer: candidate })}>Grant faculty review…</button></> : null}
      </li>)}</ul> : <p role="note">No college faculty member or department head has this email.</p>) : null}
      {reviewers && !reviewers.length ? <V2EmptyState icon="🎓" title="No faculty reviewers yet" note="A capability administrator grants faculty review to a college faculty member the college has agreed to lend." /> : null}
      {reviewers && reviewers.length ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Reviewers">
        <thead><tr><th>Reviewer</th><th>College</th><th>Role</th><th>Since</th><th>Open</th><th /></tr></thead>
        <tbody>{reviewers.map((reviewer) => <tr key={reviewer.membershipId}>
          <td>{reviewer.email}{reviewer.state !== 'ACTIVE' ? <> <StatusBadge label="Membership not active" tone="warning" /></> : null}</td>
          <td>{reviewer.institutionName}</td>
          <td>{roleWords[reviewer.role] ?? reviewer.role}</td>
          <td>{reviewer.grant ? day(reviewer.grant.grantedAt) : 'NA'}</td>
          <td>{reviewer.openAssignments}</td>
          <td>{policy.viewer.administer ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'revoke', reviewer })}>Revoke…</button> : null}</td>
        </tr>)}</tbody></table></div> : null}
    </section> : null}

    {policy && policy.viewer.assign ? <section className="role-card role-wide" aria-label="Assign drafts"><div className="role-section-title"><h2>Assign drafts in review</h2></div>
      {revisions && !revisions.length ? <V2EmptyState icon="📭" title="No drafts in review" note="Drafts appear here once their editor submits them for review in the editors above." /> : null}
      {revisions && revisions.length ? <>
        <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Drafts in review">
          <thead><tr><th /><th>Draft</th><th>Kind</th><th>Revision</th><th>Faculty so far</th></tr></thead>
          <tbody>{revisions.map((revision) => <tr key={revision.revisionId}>
            <td><input type="checkbox" aria-label={`Select ${revision.stableKey}`} checked={selected.includes(revision.revisionId)}
              onChange={(event) => setSelected(event.target.checked ? [...selected, revision.revisionId] : selected.filter((id) => id !== revision.revisionId))} /></td>
            <td>{revision.title}<br /><small>{revision.stableKey}</small></td>
            <td>{kindWords[revision.entityType] ?? revision.entityType}</td>
            <td>{revision.revision}</td>
            <td>{revision.openAssignments} open · {revision.decisions.approve} approved · {revision.decisions.requestChanges} changes</td>
          </tr>)}</tbody></table></div>
        <div className="role-actions">
          <label className="role-local-search"><span>Reviewer</span>
            <select aria-label="Reviewer" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}>
              <option value="">Choose a reviewer…</option>
              {granted.map((reviewer) => <option key={reviewer.membershipId} value={reviewer.membershipId}>{reviewer.email} — {reviewer.institutionName}</option>)}
            </select></label>
          <label className="role-local-search"><span>Days</span>
            <input type="number" aria-label="Days" min={policy.window.min} max={policy.window.max} value={days} onChange={(event) => setDays(Number(event.target.value))} /></label>
          <button type="button" className="pilot-btn" disabled={!selected.length || !chosenReviewer || days < policy.window.min || days > policy.window.max}
            onClick={() => { if (chosenReviewer) setDialog({ kind: 'assign', revisionIds: selected, reviewer: chosenReviewer, days }); }}>Assign {selected.length || ''}…</button>
        </div>
      </> : null}
    </section> : null}

    {policy ? <section className="role-card role-wide" aria-label="Assignments"><div className="role-section-title"><h2>Assignments and faculty decisions</h2></div>
      {assignments && !assignments.length ? <V2EmptyState icon="🗂️" title="No assignments yet" note="Assigned drafts and what faculty said about them appear here." /> : null}
      {assignments && assignments.length ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Assignment list">
        <thead><tr><th>Draft</th><th>Reviewer</th><th>Status</th><th>Until</th><th>Faculty decision</th><th /></tr></thead>
        <tbody>{assignments.map((assignment) => <tr key={assignment.id}>
          <td>{assignment.revision.title}<br /><small>{kindWords[assignment.revision.entityType] ?? assignment.revision.entityType} · {assignment.revision.stableKey} · r{assignment.revision.revision}</small></td>
          <td>{assignment.reviewer.email}<br /><small>{assignment.reviewer.institutionName}{assignment.reviewer.eligible ? '' : ' · no longer eligible'}</small></td>
          <td><StatusBadge label={statusWords[assignment.status].label} tone={statusWords[assignment.status].tone} /></td>
          <td>{day(assignment.expiresAt)}</td>
          <td>{assignment.decision ? <><strong>{decisionWords[assignment.decision.decision]}</strong> ({assignment.decision.reasonCode}){assignment.decision.comment ? <><br /><q>{assignment.decision.comment}</q></> : null}</> : 'NA'}</td>
          <td>{policy.viewer.assign && assignment.status === 'OPEN' ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'withdraw', assignment })}>Withdraw…</button> : null}</td>
        </tr>)}</tbody></table></div> : null}
    </section> : null}

    {dialog ? <ReasonDialog
      title={dialog.kind === 'grant' ? `Grant faculty review to ${dialog.reviewer.email}` : dialog.kind === 'revoke' ? `Revoke faculty review from ${dialog.reviewer.email}`
        : dialog.kind === 'assign' ? `Assign ${dialog.revisionIds.length} ${dialog.revisionIds.length === 1 ? 'draft' : 'drafts'} to ${dialog.reviewer.email}` : 'Withdraw this assignment'}
      facts={dialog.kind === 'grant' ? ['Approval: not required — faculty review is not a high-risk capability.', 'They will see nothing until a reviewer assigns them a draft.']
        : dialog.kind === 'revoke' ? ['Their open assignments are withdrawn at once.']
          : dialog.kind === 'assign' ? [`For ${dialog.days} ${dialog.days === 1 ? 'day' : 'days'}. They see only these drafts, without answer keys.`, 'Their decision is advice; approving and publishing stay with ONE.']
            : ['The reviewer loses access to this draft at once.']}
      reasons={reasonsFor(dialog)} submitLabel={dialog.kind === 'grant' ? 'Grant' : dialog.kind === 'assign' ? 'Assign' : dialog.kind === 'revoke' ? 'Revoke' : 'Withdraw'}
      onCancel={() => setDialog(null)} onSubmit={act} /> : null}
  </section>;
}

/** A confirm dialog that requires a reason code (Appendix 1 §6.5). */
function ReasonDialog({ title, facts, reasons, submitLabel, onCancel, onSubmit }: {
  readonly title: string; readonly facts: readonly string[]; readonly reasons: readonly string[]; readonly submitLabel: string;
  readonly onCancel: () => void; readonly onSubmit: (reasonCode: string) => Promise<void>;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) return;
    setBusy(true);
    await onSubmit(reasonCode);
    setBusy(false);
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="external-review-dialog-title">
      <h2 id="external-review-dialog-title">{title}</h2>
      <ul>{facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select aria-label="Reason code" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </form>
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// Institution portal: the faculty member's queue
// ---------------------------------------------------------------------------

export function FacultyContentReviewsPage({ institutionId, hideWhenForbidden = false }: {
  readonly institutionId: string; readonly hideWhenForbidden?: boolean;
}): React.ReactElement | null {
  const token = getProtectedAccessToken() ?? '';
  const [assignments, setAssignments] = useState<readonly FacultyReviewDto[] | null>(null);
  const [decisions, setDecisions] = useState<readonly { readonly decision: ExternalReviewDecision; readonly reasons: readonly string[] }[]>([]);
  const [commentMax, setCommentMax] = useState(2000);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState<FacultyReviewDto | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const result = await listFacultyReviews(token, institutionId, signal);
    setAssignments(result.assignments);
    setDecisions(result.decisions);
    setCommentMax(result.limits.comment);
  }, [token, institutionId]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    load(controller.signal).catch((cause) => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiRequestError && cause.status === 403) setForbidden(true);
      else setError(formatApiError(cause, 'Unable to load your content reviews.'));
    });
    return () => controller.abort();
  }, [token, load]);

  if (!token) return null;
  if (forbidden && hideWhenForbidden) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Content review</span><h1>Drafts assigned to you</h1>
    <p>ONE asks college faculty to review its learning content as subject experts. You see only the drafts assigned to you, until the date shown. Your decision is advice to ONE&apos;s reviewers: it does not publish anything, and no student data is shown here.</p></div></div>;

  if (forbidden) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🎓" title="No content review access"
        note="ONE grants content review to faculty their college has agreed to lend. Nothing has been assigned to you." /></div></section>;
  }

  const openOne = async (id: string): Promise<void> => {
    setNotice('');
    try {
      const result = await getFacultyReview(token, institutionId, id);
      setOpen(result.review);
      setError('');
    } catch (cause) {
      setError(reviewError(cause, 'Unable to open this draft.'));
    }
  };

  const submitDecision = async (decision: ExternalReviewDecision, reasonCode: string, comment: string): Promise<void> => {
    if (!open) return;
    try {
      const result = await decideFacultyReview(token, institutionId, open.id, { decision, reasonCode, ...(comment.trim() ? { comment: comment.trim() } : {}) });
      setNotice(`Your decision is recorded and sent to ONE's reviewers. Reference: ${result.correlationId}`);
      setOpen(null);
      setError('');
      await load();
    } catch (cause) {
      setError(reviewError(cause, 'Your decision could not be recorded.'));
    }
  };

  const openCount = assignments ? assignments.filter((assignment) => assignment.status === 'OPEN').length : null;
  const decidedCount = assignments ? assignments.filter((assignment) => assignment.status === 'DECIDED').length : null;

  return <section className="role-module role-module--dense" aria-label="Content review">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📝" tone="blue" value={openCount ?? 'NA'} label="Waiting for your review" />
      <V2Stat icon="✅" tone="teal" value={decidedCount ?? 'NA'} label="Reviewed by you" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!assignments && !error ? <p>Loading your content reviews…</p> : null}
    {assignments && !assignments.length ? <div className="role-wide"><V2EmptyState icon="📭" title="Nothing assigned yet" note="When ONE assigns you a draft to review, it appears here." /></div> : null}
    {assignments && assignments.length ? <section className="role-card role-wide"><div className="role-record-table-wrap"><table className="role-record-table" aria-label="Your assignments">
      <thead><tr><th>Draft</th><th>Kind</th><th>Status</th><th>Until</th><th>Your decision</th><th /></tr></thead>
      <tbody>{assignments.map((assignment) => <tr key={assignment.id}>
        <td>{assignment.title ?? 'NA'}<br /><small>{assignment.stableKey}</small></td>
        <td>{kindWords[assignment.kind] ?? assignment.kind}</td>
        <td><StatusBadge label={statusWords[assignment.status].label} tone={statusWords[assignment.status].tone} /></td>
        <td>{day(assignment.expiresAt)}</td>
        <td>{assignment.decision ? `${decisionWords[assignment.decision.decision]} (${assignment.decision.reasonCode})` : 'NA'}</td>
        <td>{assignment.status === 'OPEN' ? <button type="button" className="secondary" onClick={() => void openOne(assignment.id)}>Review…</button> : null}</td>
      </tr>)}</tbody></table></div></section> : null}
    {open ? <FacultyReviewPanel review={open} decisions={decisions} commentMax={commentMax} onClose={() => setOpen(null)} onSubmit={submitDecision} /> : null}
  </section>;
}

function DraftContent({ content }: { readonly content: FacultyReviewContentDto }): React.ReactElement {
  if (content.kind === 'SKILL') {
    return <dl>
      <div><dt>Skill</dt><dd>{content.name}</dd></div>
      <div><dt>Description</dt><dd>{content.description || 'NA'}</dd></div>
      {content.levels.map((level) => <div key={level.level}><dt>{level.level}</dt><dd>{level.descriptor || 'NA'}</dd></div>)}
      <div><dt>Prerequisites</dt><dd>{content.prerequisites.length ? content.prerequisites.join(', ') : 'None'}</dd></div>
      <div><dt>Basis</dt><dd>{content.basis ?? 'NA'}</dd></div>
    </dl>;
  }
  if (content.kind === 'QUESTION') {
    return <dl>
      <div><dt>Skill</dt><dd>{content.skill ?? 'NA'}</dd></div>
      <div><dt>Difficulty</dt><dd>{content.difficulty ?? 'NA'}</dd></div>
      <div><dt>Question</dt><dd>{content.prompt}</dd></div>
      <div><dt>Options</dt><dd><ol type="a">{content.options.map((option) => <li key={option.id}>{option.text}</li>)}</ol></dd></div>
      <div><dt>Answer key</dt><dd>Not shown to external reviewers.</dd></div>
    </dl>;
  }
  return <dl>
    <div><dt>Lesson</dt><dd>{content.title}</dd></div>
    {content.variant ? <div><dt>Variant</dt><dd>{content.variant.language} · {content.variant.level} · {content.variant.style}</dd></div> : null}
    <div><dt>Summary</dt><dd>{content.summary || 'NA'}</dd></div>
    <div><dt>Practice</dt><dd>{content.practice ?? 'NA'}</dd></div>
    <div><dt>Prerequisites</dt><dd>{content.prerequisites.length ? content.prerequisites.join(', ') : 'None'}</dd></div>
    <div><dt>Basis</dt><dd>{content.basis ?? 'NA'}</dd></div>
  </dl>;
}

function FacultyReviewPanel({ review, decisions, commentMax, onClose, onSubmit }: {
  readonly review: FacultyReviewDto;
  readonly decisions: readonly { readonly decision: ExternalReviewDecision; readonly reasons: readonly string[] }[];
  readonly commentMax: number;
  readonly onClose: () => void;
  readonly onSubmit: (decision: ExternalReviewDecision, reasonCode: string, comment: string) => Promise<void>;
}): React.ReactElement {
  const [decision, setDecision] = useState<ExternalReviewDecision | ''>('');
  const [reasonCode, setReasonCode] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const reasons = decisions.find((entry) => entry.decision === decision)?.reasons ?? [];
  const needsComment = decision === 'REQUEST_CHANGES';
  const ready = Boolean(decision && reasonCode && (!needsComment || comment.trim()));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready || !decision) return;
    setBusy(true);
    await onSubmit(decision, reasonCode, comment);
    setBusy(false);
  };
  return <section className="role-card role-wide" aria-label="Draft under review">
    <div className="role-section-title"><h2>{review.title ?? review.stableKey}</h2>
      <button type="button" className="secondary" onClick={onClose}>Close</button></div>
    {review.content ? <DraftContent content={review.content} /> : <p role="note">This draft is no longer open for your review.</p>}
    {review.content ? <form onSubmit={(event) => void submit(event)} noValidate aria-label="Your decision">
      <label><span>Decision <em>required</em></span>
        <select aria-label="Decision" value={decision} onChange={(event) => { setDecision(event.target.value as ExternalReviewDecision | ''); setReasonCode(''); }}>
          <option value="">Choose…</option>
          {decisions.map((entry) => <option key={entry.decision} value={entry.decision}>{decisionWords[entry.decision]}</option>)}
        </select></label>
      <label><span>Reason code <em>required</em></span>
        <select aria-label="Reason code" value={reasonCode} disabled={!decision} onChange={(event) => setReasonCode(event.target.value)}>
          <option value="">Choose a reason…</option>
          {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select></label>
      <label><span>Comment {needsComment ? <em>required</em> : '(optional)'} — about the content only; do not include personal details</span>
        <textarea aria-label="Comment" value={comment} maxLength={commentMax} onChange={(event) => setComment(event.target.value)} /></label>
      <p role="note">Your decision is advice to ONE&apos;s reviewers. It does not approve or publish this draft.</p>
      <div className="role-modal-actions"><button type="submit" className="pilot-btn" disabled={busy || !ready}>{busy ? 'Recording…' : 'Record decision'}</button></div>
    </form> : null}
  </section>;
}
