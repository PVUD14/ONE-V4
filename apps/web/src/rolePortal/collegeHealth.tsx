/**
 * ONE · Role portal — Operations college health (Analytics) and college account fields
 * (Organization Detail), OPS-14, Appendix 1 §3 Customer success, §4.2, §5.3, §5.5.
 *
 * Analytics: every college with its rostered and signed-in students, weekly active
 * learners, staff activity, open support cases, verification state and renewal date,
 * sorted by renewal date or by activity, and one college's view with a four-week trend,
 * assessments taken and the readiness band distribution (bands only). Counts of people
 * arrive suppressed: below 5 shows "<5", and a total withheld so a smaller cell cannot be
 * worked out shows "Withheld". A figure with no source says NA in its slot.
 *
 * Organization Detail: a college's renewal date, contract reference, AI8HT account owner
 * and contacts. Every change asks for a reason code; contacts show masked, and the full
 * value is revealed only with a reason, which is recorded.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  addCollegeContact,
  ApiRequestError,
  getCollegeAccount,
  getCollegeAccountPolicy,
  getCollegeHealthDetail,
  getCollegeHealthList,
  getProtectedAccessToken,
  listOperationsOrganizations,
  removeCollegeContact,
  revealCollegeContact,
  updateCollegeAccount,
} from '../api.js';
import type {
  CollegeAccountDto,
  CollegeAccountPolicyDto,
  CollegeContactDto,
  CollegeHealthDetailResponseDto,
  CollegeHealthListResponseDto,
  CollegeHealthRowDto,
  CollegePeopleCountDto,
  CollegeSplitDto,
} from '../api.js';
import { V2Bar, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

const NA = 'NA';

export function formatCollegePeople(count: CollegePeopleCountDto | undefined): string {
  if (!count) return NA;
  return count.suppressed ? '<5' : count.value.toLocaleString();
}

/** A split total: "<5" when the whole split is small, "Withheld" when only the total is hidden. */
export function formatSplitTotal(split: CollegeSplitDto | undefined): string {
  if (!split) return NA;
  if (!split.total.suppressed) return split.total.value.toLocaleString();
  return split.yes.suppressed && split.no.suppressed ? '<5' : 'Withheld';
}

const bandLabel: Readonly<Record<string, string>> = {
  NOT_ENOUGH_EVIDENCE: 'Not enough evidence',
  DEVELOPING: 'Developing',
  PROGRESSING: 'Progressing',
  READY_FOR_NEXT_STEP: 'Ready for next step',
};

function words(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
}

function dateText(value: string | null | undefined): string {
  if (!value) return NA;
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Shown counts first, largest first; suppressed after, by name, never by true size (as the server). */
function byActivity(colleges: readonly CollegeHealthRowDto[]): CollegeHealthRowDto[] {
  return [...colleges].sort((a, b) => {
    const av = a.weeklyActiveLearners.suppressed ? null : a.weeklyActiveLearners.value;
    const bv = b.weeklyActiveLearners.suppressed ? null : b.weeklyActiveLearners.value;
    if (av !== null && bv !== null && av !== bv) return bv - av;
    if (av !== null && bv === null) return -1;
    if (av === null && bv !== null) return 1;
    return a.name.localeCompare(b.name);
  });
}

function forbiddenReference(cause: unknown): string {
  return cause instanceof ApiRequestError && cause.status === 403 ? cause.correlationId : '';
}

// ---------------------------------------------------------------------------
// Analytics: college health
// ---------------------------------------------------------------------------

export function OperationsCollegeHealthPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [list, setList] = useState<CollegeHealthListResponseDto['health'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [sort, setSort] = useState<'renewal' | 'activity'>('renewal');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CollegeHealthDetailResponseDto['detail'] | null>(null);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    getCollegeHealthList(token, controller.signal)
      .then((result) => { setList(result.health); setError(''); setForbidden(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        const reference = forbiddenReference(cause);
        if (reference) setForbidden(reference);
        else setError(formatApiError(cause, 'Unable to load college health.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || !selectedId) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailError('');
    getCollegeHealthDetail(token, selectedId, controller.signal)
      .then((result) => setDetail(result.detail))
      .catch((cause) => { if (!controller.signal.aborted) setDetailError(formatApiError(cause, 'Unable to load this college.')); });
    return () => controller.abort();
  }, [token, selectedId]);

  const rows = useMemo(() => (sort === 'activity' ? byActivity(list?.colleges ?? []) : [...(list?.colleges ?? [])]), [list, sort]);

  // The role demand page above already shows the sign-in state for Analytics.
  if (!token) return null;

  const title = <div className="role-section-title"><h2>College health</h2></div>;
  if (forbidden) {
    return <section className="role-card role-wide" aria-label="College health">{title}
      <V2EmptyState icon="🔐" title="Not permitted" note="College health is for staff who hold aggregate analytics access. Your access has not changed." hint={`Reference: ${forbidden}`} />
    </section>;
  }

  const windows = list?.windows;
  return <section className="role-module role-module--dense" aria-label="College health">
    <div className="role-page-heading"><div><span className="eyebrow">Operations · customer success</span><h2>College health</h2>
      <p>Each college&apos;s activation, learning activity, staff activity, open support cases and renewal date. Counts of fewer than 5 people show &lt;5; no student is ever named and readiness appears only as bands.</p>
      {windows ? <p>Activity is for the last complete week, {dateText(windows.weekStart)} to {dateText(windows.weekEnd)} (UTC). Assessments and readiness bands are for {windows.month}, the last full month. Fixed periods keep the figures from being compared day by day to single anyone out.</p> : null}
    </div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loading && !list ? <p>Loading college health…</p> : null}

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🏫" tone="blue" value={list ? list.totals.colleges.toLocaleString() : NA} label="Colleges in ONE" />
      <V2Stat icon="📅" tone="amber" value={list ? list.totals.renewingWithin90Days.toLocaleString() : NA} label="Renewing within 90 days" />
      <V2Stat icon="❔" tone="purple" value={list ? list.totals.withoutRenewalDate.toLocaleString() : NA} label="No renewal date recorded" />
      <V2Stat icon="🎧" tone="teal" value={list ? list.totals.openSupportCases.toLocaleString() : NA} label="Open support cases" />
    </div>

    <section className="role-card role-wide"><h2>Colleges</h2>
      <div className="role-management-form">
        <label><span>Sort by</span><select aria-label="Sort colleges" value={sort} onChange={(event) => setSort(event.target.value === 'activity' ? 'activity' : 'renewal')}>
          <option value="renewal">Renewal date, soonest first</option>
          <option value="activity">Weekly active learners</option>
        </select></label>
      </div>
      {list && !list.colleges.length ? <V2EmptyState icon="🏫" title="No colleges yet" note="No institution has been added to ONE in this environment, so there is no college health to show." /> : null}
      {list?.collegesCapped ? <p>Showing the first 500 colleges only.</p> : null}
      {rows.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <caption className="sr-only">College health by college</caption>
        <thead><tr><th>College</th><th>Verification</th><th>Renewal</th><th>Students rostered</th><th>Signed in</th><th>Not yet signed in</th><th>Active learners last week</th><th>Staff active last week</th><th>Open cases</th><th>Actions</th></tr></thead>
        <tbody>{rows.map((college) => <tr key={college.id}>
          <th scope="row">{college.name}{college.active ? null : <><br /><small>Inactive</small></>}</th>
          <td><StatusBadge label={words(college.verificationState)} tone={college.verificationState === 'VERIFIED' ? 'success' : 'info'} /></td>
          <td>{dateText(college.renewalDate)}</td>
          <td>{formatSplitTotal(college.students)}</td>
          <td>{formatCollegePeople(college.students.yes)}</td>
          <td>{formatCollegePeople(college.students.no)}</td>
          <td>{formatCollegePeople(college.weeklyActiveLearners)}</td>
          <td>{formatCollegePeople(college.staff.yes)} of {formatSplitTotal(college.staff)}</td>
          <td>{college.openSupportCases.toLocaleString()}{college.overdueSupportCases ? ` (${college.overdueSupportCases.toLocaleString()} overdue)` : ''}</td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(college.id)} aria-label={`Health of ${college.name}`}>Details…</button></td>
        </tr>)}</tbody></table></div> : null}
      <p>&quot;Withheld&quot; hides a total of 5 or more so that a smaller count beside it cannot be worked out by subtraction. Staff count as active when they made a recorded change for the college that week; viewing alone is not recorded.</p>
    </section>

    {selectedId ? <section className="role-card role-wide" aria-label="College health detail">
      <div className="role-section-title"><h2>{detail ? detail.college.name : 'College'}: health</h2>
        <button type="button" className="secondary" onClick={() => { setSelectedId(null); setDetail(null); setDetailError(''); }}>Close</button></div>
      {detailError ? <p className="form-error" role="alert">{detailError}</p> : null}
      {!detail && !detailError ? <p>Loading college…</p> : null}
      {detail ? <CollegeHealthDetail detail={detail} /> : null}
    </section> : null}
  </section>;
}

function CollegeHealthDetail({ detail }: { readonly detail: CollegeHealthDetailResponseDto['detail'] }): React.ReactElement {
  const trendMax = Math.max(1, ...detail.weeklyActiveTrend.map((week) => (week.learners.suppressed ? 0 : week.learners.value)));
  const bands = detail.readinessBands;
  return <>
    <div className="v2-row v2-cols-4 career-stat-strip">
      <V2Stat icon="🎓" tone="blue" value={formatSplitTotal(detail.college.students)} label="Students rostered" />
      <V2Stat icon="✅" tone="teal" value={formatCollegePeople(detail.college.students.yes)} label="Signed in" />
      <V2Stat icon="📝" tone="purple" value={formatCollegePeople(detail.assessments.attempts)} label={`Assessment attempts, ${detail.windows.month}`} />
      <V2Stat icon="🧑‍🏫" tone="amber" value={formatCollegePeople(detail.staffActionsOpened)} label="Staff actions opened last week" />
    </div>
    <div className="v2-row v2-cols-2">
      <section className="role-card"><h3>Weekly active learners</h3>
        <ul className="role-check-list" aria-label="Weekly active learners">{detail.weeklyActiveTrend.map((week) => <li key={week.weekStart}>
          <span>Week of {dateText(week.weekStart)}: <strong>{formatCollegePeople(week.learners)}</strong></span>
          {week.learners.suppressed ? null : <V2Bar percent={(week.learners.value / trendMax) * 100} />}
        </li>)}</ul>
        <p>Students who completed a lesson or took an assessment that week while studying at this college.</p>
      </section>
      <section className="role-card"><h3>Readiness bands, {detail.windows.month}</h3>
        {bands.suppressed
          ? <p>Fewer than 5 students had a readiness update in {detail.windows.month}, so no bands are shown.</p>
          : <dl>{bands.bands.map((band) => <div key={band.band}><dt>{bandLabel[band.band] ?? words(band.band)}</dt><dd>{band.suppressed || band.count === null ? '<5' : band.count.toLocaleString()}</dd></div>)}
              <div><dt>Students with an update</dt><dd>{bands.cohortSizeSuppressed || bands.cohortSize === null ? 'Withheld' : bands.cohortSize.toLocaleString()}</dd></div></dl>}
        <p>Readiness band movement: {NA}. Movement per student is not computed; each month&apos;s distribution stands on its own.</p>
      </section>
    </div>
    <dl>
      <div><dt>Assessments taken, {detail.windows.month}</dt><dd>{formatCollegePeople(detail.assessments.attempts)} attempts by {formatCollegePeople(detail.assessments.students)} students</dd></div>
      <div><dt>Staff active last week</dt><dd>{formatCollegePeople(detail.college.staff.yes)} of {formatSplitTotal(detail.college.staff)} staff</dd></div>
      <div><dt>Open support cases</dt><dd>{detail.college.openSupportCases.toLocaleString()} ({detail.college.overdueSupportCases.toLocaleString()} past their target time)</dd></div>
      <div><dt>Verification</dt><dd>{words(detail.college.verificationState)}</dd></div>
      <div><dt>Renewal date</dt><dd>{dateText(detail.college.renewalDate)}</dd></div>
    </dl>
  </>;
}

// ---------------------------------------------------------------------------
// Organization Detail: account fields
// ---------------------------------------------------------------------------

type AccountDialog =
  | { readonly kind: 'fields' }
  | { readonly kind: 'add' }
  | { readonly kind: 'remove'; readonly contact: CollegeContactDto }
  | { readonly kind: 'reveal'; readonly contact: CollegeContactDto };

export function OperationsCollegeAccountPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [colleges, setColleges] = useState<readonly { readonly id: string; readonly name: string }[]>([]);
  const [collegeId, setCollegeId] = useState('');
  const [policy, setPolicy] = useState<CollegeAccountPolicyDto | null>(null);
  const [account, setAccount] = useState<CollegeAccountDto | null>(null);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const [revealed, setRevealed] = useState<Readonly<Record<string, { readonly email: string | null; readonly phone: string | null }>>>({});

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getCollegeAccountPolicy(token, controller.signal)
      .then((result) => { setPolicy(result); setForbidden(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        const reference = forbiddenReference(cause);
        if (reference) setForbidden(reference);
        else setError(formatApiError(cause, 'Unable to load account settings.'));
      });
    listOperationsOrganizations(token, { q: '', kind: 'INSTITUTION', verification: '' }, controller.signal)
      .then((result) => setColleges(result.organizations.map((org) => ({ id: org.id, name: org.profile.displayName || org.legalName }))))
      .catch(() => undefined);
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || !collegeId || forbidden) return;
    const controller = new AbortController();
    setAccount(null);
    setRevealed({});
    setNotice('');
    getCollegeAccount(token, collegeId, controller.signal)
      .then((result) => { setAccount(result.account); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this college\'s account.')); });
    return () => controller.abort();
  }, [token, collegeId, forbidden]);

  if (!token) return null;

  const heading = <div className="role-section-title"><h2>College account</h2></div>;
  if (forbidden) {
    return <section className="role-card role-wide" aria-label="College account">{heading}
      <V2EmptyState icon="🔐" title="Not permitted" note="College account fields are for staff who hold account management access. Your access has not changed." hint={`Reference: ${forbidden}`} />
    </section>;
  }

  const fields = account?.account;
  return <section className="role-card role-wide" aria-label="College account">
    {heading}
    <p>AI8HT&apos;s own record for a college: when its agreement renews, the paper contract&apos;s reference, who at AI8HT looks after it, and whom to call there. No amounts are kept in ONE. Colleges never see these fields.</p>
    <div className="role-management-form">
      <label><span>College</span><select aria-label="College" value={collegeId} onChange={(event) => setCollegeId(event.target.value)}>
        <option value="">Choose a college…</option>
        {colleges.map((college) => <option key={college.id} value={college.id}>{college.name}</option>)}
      </select></label>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {!collegeId ? <p>Choose a college to see its account fields.</p> : null}
    {collegeId && !account && !error ? <p>Loading account…</p> : null}
    {account ? <>
      <div className="role-section-title"><h3>{account.institution.name}</h3>
        <div className="role-actions"><button type="button" onClick={() => setDialog({ kind: 'fields' })} disabled={!policy}>Edit account fields…</button></div></div>
      <dl>
        <div><dt>Renewal date</dt><dd>{dateText(fields?.renewalDate)}</dd></div>
        <div><dt>Contract reference</dt><dd>{fields?.contractReference ?? NA}</dd></div>
        <div><dt>AI8HT account owner</dt><dd>{fields?.accountOwner ? `${fields.accountOwner.email} (${words(fields.accountOwner.role)})${fields.accountOwner.active ? '' : ' — no longer active'}` : NA}</dd></div>
        <div><dt>Verification</dt><dd>{words(account.institution.verificationState)}</dd></div>
        <div><dt>Last changed</dt><dd>{fields ? new Date(fields.updatedAt).toLocaleString() : 'Never'}</dd></div>
      </dl>
      <div className="role-section-title"><h3>College contacts</h3>
        <div className="role-actions"><button type="button" className="secondary" onClick={() => setDialog({ kind: 'add' })} disabled={!policy || account.contacts.length >= account.contactLimit}>Add contact…</button></div></div>
      {account.contacts.length ? <table className="role-record-table"><caption className="sr-only">College contacts</caption>
        <thead><tr><th>Role</th><th>Name</th><th>Email</th><th>Phone</th><th>Actions</th></tr></thead>
        <tbody>{account.contacts.map((contact) => {
          const full = revealed[contact.id];
          return <tr key={contact.id}>
            <td>{words(contact.role)}</td>
            <th scope="row">{contact.name}</th>
            <td>{full ? full.email ?? NA : contact.email ?? NA}{full ? ' (revealed, recorded)' : ''}</td>
            <td>{full ? full.phone ?? NA : contact.phone ?? NA}</td>
            <td><div className="role-record-actions">
              {full ? null : <button type="button" className="secondary" onClick={() => setDialog({ kind: 'reveal', contact })} aria-label={`Reveal contact for ${contact.name}`}>Reveal…</button>}
              <button type="button" className="secondary" onClick={() => setDialog({ kind: 'remove', contact })} aria-label={`Remove ${contact.name}`}>Remove…</button>
            </div></td>
          </tr>;
        })}</tbody></table>
        : <p>No contacts recorded for this college.</p>}
      <p>Emails and phone numbers are masked. Revealing one, and every change here, is recorded in the audit log with your reason.</p>
    </> : null}
    {dialog && policy && account ? <AccountDialogView token={token} dialog={dialog} policy={policy} account={account}
      onCancel={() => setDialog(null)}
      onSaved={(next, message) => { setDialog(null); setAccount(next); setNotice(message); }}
      onRevealed={(contactId, contact) => { setDialog(null); setRevealed((value) => ({ ...value, [contactId]: contact })); }} /> : null}
  </section>;
}

function AccountDialogView({ token, dialog, policy, account, onCancel, onSaved, onRevealed }: {
  readonly token: string; readonly dialog: AccountDialog; readonly policy: CollegeAccountPolicyDto; readonly account: CollegeAccountDto;
  readonly onCancel: () => void;
  readonly onSaved: (account: CollegeAccountDto, message: string) => void;
  readonly onRevealed: (contactId: string, contact: { readonly email: string | null; readonly phone: string | null }) => void;
}): React.ReactElement {
  const current = account.account;
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [renewalDate, setRenewalDate] = useState(current?.renewalDate ?? '');
  const [contractReference, setContractReference] = useState(current?.contractReference ?? '');
  const [ownerId, setOwnerId] = useState(current?.accountOwner?.membershipId ?? '');
  const [role, setRole] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reasons = dialog.kind === 'fields' ? policy.reasons.update : dialog.kind === 'add' ? policy.reasons.addContact : dialog.kind === 'remove' ? policy.reasons.removeContact : policy.reasons.reveal;
  const title = dialog.kind === 'fields' ? 'Edit account fields' : dialog.kind === 'add' ? 'Add a college contact' : dialog.kind === 'remove' ? `Remove ${dialog.contact.name}` : `Reveal contact for ${dialog.contact.name}`;
  const record = dialog.kind === 'reveal'
    ? 'Revealing the full email and phone is recorded in the audit log with your reason.'
    : dialog.kind === 'remove'
      ? 'Removing a contact erases their name, email and phone from ONE. The change is recorded with your reason.'
      : 'The change is recorded in the audit log with your reason.';

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    setError('');
    const extra = note.trim() ? { note: note.trim() } : {};
    try {
      if (dialog.kind === 'fields') {
        const changes = {
          ...((renewalDate || null) !== (current?.renewalDate ?? null) ? { renewalDate: renewalDate || null } : {}),
          ...((contractReference.trim() || null) !== (current?.contractReference ?? null) ? { contractReference: contractReference.trim() || null } : {}),
          ...((ownerId || null) !== (current?.accountOwner?.membershipId ?? null) ? { accountOwnerMembershipId: ownerId || null } : {}),
        };
        if (!Object.keys(changes).length) { setError('Nothing has changed.'); setBusy(false); return; }
        const body = { reasonCode, ...extra, expectedVersion: current?.version ?? null, ...changes };
        const result = await updateCollegeAccount(token, account.institution.id, body);
        onSaved(result.account, 'Account fields saved.');
      } else if (dialog.kind === 'add') {
        if (!role || !name.trim() || (!email.trim() && !phone.trim())) { setError('Give a role, a name and an email or phone.'); setBusy(false); return; }
        const result = await addCollegeContact(token, account.institution.id, {
          reasonCode, ...extra, role, name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(phone.trim() ? { phone: phone.trim() } : {}),
        });
        onSaved(result.account, 'Contact added.');
      } else if (dialog.kind === 'remove') {
        const result = await removeCollegeContact(token, account.institution.id, dialog.contact.id, { reasonCode, ...extra });
        onSaved(result.account, 'Contact removed and their details erased.');
      } else {
        const result = await revealCollegeContact(token, account.institution.id, dialog.contact.id, { reasonCode, ...extra });
        onRevealed(dialog.contact.id, result.contact);
      }
    } catch (cause) {
      setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="college-account-dialog-title">
      <h2 id="college-account-dialog-title">{title}</h2>
      <dl><div><dt>Record</dt><dd>{record}</dd></div><div><dt>Approval</dt><dd>Not required.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        {dialog.kind === 'fields' ? <>
          <label><span>Renewal date</span><input type="date" value={renewalDate} onChange={(event) => setRenewalDate(event.target.value)} /></label>
          <label><span>Contract reference</span><input value={contractReference} maxLength={64} onChange={(event) => setContractReference(event.target.value)} placeholder="Reference only — no amounts" /></label>
          <label><span>AI8HT account owner</span><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
            <option value="">No owner</option>
            {policy.owners.map((owner) => <option key={owner.membershipId} value={owner.membershipId}>{owner.email} ({words(owner.role)})</option>)}
          </select></label>
        </> : null}
        {dialog.kind === 'add' ? <>
          <label><span>Role <em>required</em></span><select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">Choose a role…</option>
            {policy.contactRoles.map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select></label>
          <label><span>Name <em>required</em></span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label><span>Phone</span><input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        </> : null}
        <label><span>Reason code <em>required</em></span>
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <label><span>Note (optional, no personal details)</span><textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : dialog.kind === 'reveal' ? 'Reveal' : 'Save'}</button>
        </div>
      </form>
    </section>
  </div>;
}

function accountErrorText(cause: unknown): string {
  if (!(cause instanceof ApiRequestError)) return 'The change could not be saved.';
  const messages: Readonly<Record<string, string>> = {
    COLLEGE_ACCOUNT_VERSION_CONFLICT: 'Someone else changed this account since you opened it. Close this and reopen the college to see the latest.',
    COLLEGE_ACCOUNT_OWNER_INVALID: 'The owner must be an active member of AI8HT operations.',
    COLLEGE_ACCOUNT_UNCHANGED: 'Nothing has changed.',
    COLLEGE_CONTACT_LIMIT_REACHED: 'This college already has the most contacts ONE keeps. Remove one first.',
    CONTRACT_REFERENCE_INVALID: 'A contract reference is letters, digits and / _ . : - only, with no spaces or amounts.',
    RENEWAL_DATE_INVALID: 'Enter a real renewal date.',
    CONTACT_EMAIL_INVALID: 'Enter a valid email address.',
    CONTACT_PHONE_INVALID: 'Enter a valid phone number.',
  };
  const message = (cause.code ? messages[cause.code] : undefined) ?? formatApiError(cause, 'The change could not be saved.');
  return message.includes('Reference:') ? message : `${message} Reference: ${cause.correlationId}`;
}
