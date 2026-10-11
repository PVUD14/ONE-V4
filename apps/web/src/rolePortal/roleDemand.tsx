/**
 * ONE · Role portal — Operations: Analytics, the role demand dashboard (OPS-11,
 * Appendix 1 §4.2, §5.5–5.7).
 *
 * Roles ranked by how many students target them, colleges per role, demand by release
 * label, a 12-month selection trend, and a "meets promotion rule" indicator against the
 * catalogue's rule (200 students across 3 colleges, or a paying employer's request).
 * Opening a role shows its colleges and, within each, departments.
 *
 * Every number comes from one server-side summary; counts of people arrive already
 * suppressed. Below 5 shows "<5"; a cell withheld only so a smaller one cannot be worked
 * out by subtraction shows "Withheld". Employer demand has no source, so it has no tile; the
 * promotion-rule card says in words that it is not recorded. No student is ever named here.
 */
import { useEffect, useMemo, useState } from 'react';
import { ApiRequestError, getProtectedAccessToken, getRoleDemandDetail, getRoleDemandSummary } from '../api.js';
import type { RoleDemandCellDto, RoleDemandDetailResponseDto, RoleDemandPeopleCountDto, RoleDemandRoleDto, RoleDemandSummaryResponseDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { CountBars, NaValue, SuppressionNote } from '../naState.js';
import { shownCount, smallCountText } from '../momentum/smallCountRule.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError, RestrictedApiState } from './shared.js';
import { SupportCode } from '../supportCode.js';

/** Roles listed before "Show all": the ranked head of the list; the rest stay one click away. */
const ROLE_PAGE = 25;

/** A people count as the server suppressed it; undefined when there is no count, so its slot is hidden. */
export function formatPeople(count: RoleDemandPeopleCountDto, complementary?: boolean): string;
export function formatPeople(count: RoleDemandPeopleCountDto | undefined, complementary?: boolean): string | undefined;
export function formatPeople(count: RoleDemandPeopleCountDto | undefined, complementary = false): string | undefined {
  if (!count) return undefined;
  if (complementary) return 'Withheld';
  return smallCountText(count, (value) => value.toLocaleString());
}

const releaseLabelText: Readonly<Record<string, string>> = { SELECTABLE: 'Selectable', VERIFIED: 'Verified', NONE: 'Not in catalogue' };

function PromotionBadge({ role }: { readonly role: RoleDemandRoleDto }): React.ReactElement {
  if (role.promotion.status === 'MEETS') return <StatusBadge label="Meets rule" tone="success" />;
  if (role.promotion.status === 'NOT_MET') return <StatusBadge label="Not met" tone="neutral" />;
  return <StatusBadge label={role.releaseLabel === 'VERIFIED' ? 'Already verified' : 'Not applicable'} tone="info" />;
}

function CellList({ cells, empty }: { readonly cells: readonly RoleDemandCellDto[]; readonly empty: string }): React.ReactElement {
  if (!cells.length) return <p>{empty}</p>;
  return <ul className="role-check-list">{cells.map((cell, index) => <li key={`${cell.label}:${index}`}>{cell.label}: <strong><NaValue value={formatPeople(cell.students, cell.complementary)} /></strong></li>)}</ul>;
}

export function OperationsRoleDemandPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [summary, setSummary] = useState<RoleDemandSummaryResponseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoleDemandDetailResponseDto['detail'] | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    getRoleDemandSummary(token, controller.signal)
      .then((result) => { setSummary(result); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load role demand.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || !selectedId) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetail(null);
    getRoleDemandDetail(token, selectedId, controller.signal)
      .then((result) => { setDetail(result.detail); setDetailError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setDetailError(formatApiError(cause, 'Unable to load this role\'s colleges.')); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [token, selectedId]);

  const demand = summary?.demand;
  const rule = summary?.promotionRule;
  const visibleRoles = useMemo(
    () => (demand?.roles ?? []).filter((role) => !labelFilter || (role.releaseLabel ?? 'NONE') === labelFilter),
    [demand, labelFilter],
  );
  // Rank among shown counts only: suppressed roles have no rank, so their order says nothing.
  const ranks = useMemo(() => {
    const map = new Map<string, number>();
    (demand?.roles ?? []).filter((role) => !role.students.suppressed).forEach((role, index) => map.set(role.id, index + 1));
    return map;
  }, [demand]);
  const [showAllRoles, setShowAllRoles] = useState(false);
  const shownRoles = showAllRoles ? visibleRoles : visibleRoles.slice(0, ROLE_PAGE);

  if (!token) return <RestrictedApiState title="Analytics" message="Sign in with an Operations identity to see role demand." />;

  const ruleText = rule
    ? `A selectable role meets the promotion rule when at least ${rule.minimumStudents} students across at least ${rule.minimumColleges} colleges target it, or a paying employer asks for it as a drive target.`
    : 'The promotion rule is not available.';
  const heading = <div className="role-page-heading"><div><span className="eyebrow">Operations · analytics</span><h1>Analytics</h1>
    <p>Role demand: how many students target each career role and across how many colleges, measured against the catalogue&apos;s promotion rule. Counts below 5 show &lt;5, and no student is ever named.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="Role demand is for staff who hold aggregate analytics access. Your access has not changed."
        hint={<SupportCode reference={forbiddenReference} />} /></div></section>;
  }

  return <section className="role-module role-module--dense">
    {heading}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loading && !summary ? <p>Loading role demand…</p> : null}

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🎯" tone="blue" value={formatPeople(demand?.totals.studentsWithTarget)} label="Students with a career target" reason={demand ? 'Too few to show' : 'Not loaded'} />
      <V2Stat icon="🗂️" tone="purple" value={demand ? demand.totals.catalogueRoles.toLocaleString() : undefined} label="Roles in the catalogue" />
      <V2Stat icon="🚀" tone="teal" value={demand ? demand.totals.rolesMeetingPromotionRule.toLocaleString() : undefined} label="Roles meeting the promotion rule" />
    </div>

    <div className="v2-row v2-cols-2 role-wide">
      <section className="role-card"><h2>Demand by release label</h2>
        {demand?.byReleaseLabel?.length
          ? <dl>{demand.byReleaseLabel.map((row) => <div key={row.releaseLabel}><dt>{releaseLabelText[row.releaseLabel] ?? row.releaseLabel} ({row.roles} roles)</dt><dd><NaValue value={formatPeople(row.students, row.complementary)} /></dd></div>)}</dl>
          : demand ? <p>No student has chosen a career target yet.</p> : null}
        <p>{ruleText}</p>
        <p>Employer demand is not recorded: no job opportunity or employer request is linked to a career role in ONE yet, so the employer part of the rule cannot be read. &quot;Not met&quot; means not met on students alone.</p>
      </section>
      <section className="role-card"><h2>New target selections by month</h2>
        <p>Students who chose a career target in each month (UTC), whether or not they kept it.</p>
        {demand?.trend?.length ? <>
          <CountBars label="Monthly trend" labelHeading="Month" valueHeading="Students"
            emptyReason="Every month had fewer than 5 new selections, so there is no trend to draw yet."
            rows={demand.trend.map((month) => ({ label: month.month, display: formatPeople(month.students), value: shownCount(month.students) }))} />
          {demand.trend.some((month) => month.students.suppressed) && demand.trend.some((month) => !month.students.suppressed) ? <SuppressionNote>A month with fewer than 5 new selections reads &quot;&lt;5&quot; and shows the hatched block, never a bar.</SuppressionNote> : null}
        </> : demand ? <p>No target selections are recorded yet.</p> : null}
      </section>
    </div>

    <section className="role-card role-wide"><h2>Roles ranked by demand</h2>
      <div className="role-management-form">
        <label><span>Release label</span><select aria-label="Release label filter" value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}>
          <option value="">All labels</option>
          <option value="SELECTABLE">Selectable</option>
          <option value="VERIFIED">Verified</option>
          <option value="NONE">Not in catalogue</option>
        </select></label>
      </div>
      {demand && !demand.roles.length ? <V2EmptyState icon="🗂️" title="No career roles loaded" note="The job-role catalogue has not been loaded in this environment, so there is no demand to show." /> : null}
      {demand && demand.roles.length && !visibleRoles.length ? <p>No roles carry this release label.</p> : null}
      {demand?.rolesCapped ? <p>Showing the first 1,000 roles only.</p> : null}
      {visibleRoles.length ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Roles ranked by demand">
        <thead><tr><th>Rank</th><th>Role</th><th>Release label</th><th>Planned</th><th>Students</th><th>Colleges</th><th>Promotion rule</th><th>Actions</th></tr></thead>
        <tbody>{shownRoles.map((role) => <tr key={role.id}>
          <td>{ranks.get(role.id) ?? '—'}</td>
          <th scope="row">{role.catalogueCode ? `${role.catalogueCode} · ` : ''}{role.title}{role.active ? null : <><br /><small>Inactive</small></>}</th>
          <td>{releaseLabelText[role.releaseLabel ?? 'NONE']}</td>
          <td>{role.plannedRelease ?? 'Not set'}</td>
          <td><NaValue value={formatPeople(role.students)} /></td>
          <td><NaValue value={role.colleges === null ? 'Withheld' : role.colleges.toLocaleString()} /></td>
          <td><PromotionBadge role={role} /></td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(role.id)} aria-label={`Colleges for ${role.title}`}>Colleges…</button></td>
        </tr>)}</tbody></table></div> : null}
      {visibleRoles.length > ROLE_PAGE ? <div className="role-management-form">
        <p className="na-caption">{showAllRoles ? `Showing all ${visibleRoles.length.toLocaleString()} roles.` : `Showing the top ${ROLE_PAGE} of ${visibleRoles.length.toLocaleString()} roles by demand.`}</p>
        <button type="button" className="secondary" onClick={() => setShowAllRoles((value) => !value)}>{showAllRoles ? `Show the top ${ROLE_PAGE} only` : `Show all ${visibleRoles.length.toLocaleString()} roles`}</button>
      </div> : null}
      {visibleRoles.some((role) => role.students.suppressed) ? <SuppressionNote>Muted figures are withheld: &quot;&lt;5&quot; is fewer than 5 students, and &quot;Withheld&quot; hides a college count that would let a small group be worked out. Roles under 5 have no rank.</SuppressionNote> : null}
    </section>

    {selectedId ? <section className="role-card role-wide" aria-label="Role demand by college">
      <div className="role-section-title"><h2>{detail ? `${detail.role.catalogueCode ? `${detail.role.catalogueCode} · ` : ''}${detail.role.title}` : 'Role'}: colleges</h2>
        <button type="button" className="secondary" onClick={() => { setSelectedId(null); setDetail(null); setDetailError(''); }}>Close</button></div>
      {detailError ? <p className="form-error" role="alert">{detailError}</p> : null}
      {detailLoading ? <p>Loading colleges…</p> : null}
      {detail && detail.colleges === null ? <V2EmptyState icon="🔒" title="Fewer than 5 students"
        note="Fewer than 5 students target this role, so no breakdown by college is shown." /> : null}
      {detail?.colleges ? <>
        <p>Students: <strong><NaValue value={formatPeople(detail.role.students)} /></strong> across <strong>{detail.role.colleges ?? 'Withheld'}</strong> colleges. Departments are as each college names them. &quot;Withheld&quot; hides a count of 5 or more so a smaller one cannot be worked out by subtraction.</p>
        {detail.collegesCapped ? <p>Showing the 200 largest colleges only.</p> : null}
        <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>College</th><th>Students</th><th>Departments</th></tr></thead>
          <tbody>{detail.colleges.map((college, index) => <tr key={`${college.label}:${index}`}>
            <th scope="row">{college.label}</th>
            <td><NaValue value={formatPeople(college.students, college.complementary)} /></td>
            <td>{college.departments ? <CellList cells={college.departments} empty="No departments recorded" /> : 'Not shown for a withheld count'}</td>
          </tr>)}</tbody></table></div>
      </> : null}
    </section> : null}
  </section>;
}
