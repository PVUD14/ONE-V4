/**
 * ONE · Role portal — Institution — placement register, statistics and drive categories (INST-12).
 *
 * What the placement office reports to management each season: statistics by department and batch
 * (eligible, applied, placed, placement percentage, offers per placed student) as of the end of the
 * last ended month, the employers the college engaged, and the drive calendar with outcomes; plus
 * the college's own drive categories (Dream, Core, Mass…) set in Settings and attached to drives.
 *
 * No navigation item is added (HG-3): the register is a section of the admin's Placement page and of
 * the placement officer's Dashboard, the department head sees their department's statistics on
 * Placement Pipeline, and categories live in Settings. The server decides scope and suppression; a
 * group under five reads <5, a student who shared nothing is "Not shared" (never unplaced), and pay
 * never appears. Categories are the college's internal labels and are never shown to employers.
 */
import { Icon } from '../icons/Icon.js';
import { useEffect, useState, type FormEvent } from 'react';
import { getProtectedAccessToken, suppressedCountLabel } from '../api.js';
import { campusDriveStateLabels, reasonLabel, venueModeLabels } from '../api/campusDrives.js';
import {
  createDriveCategory,
  driveCategoryRetireReasons,
  getPlacementRegister,
  getPlacementStatistics,
  listDriveCategories,
  retireDriveCategory,
  setCampusDriveCategory,
  type DriveCategoryDto,
  type DriveCategoryRefDto,
  type PlacementRegisterDto,
  type PlacementStatisticsDto,
  type PlacementStatisticsRowDto,
} from '../api/placementRegister.js';
import { Kpis, loadError } from './institutionDepartment.js';
import { formatApiError } from './shared.js';
import * as dates from '../dates.js';

function formatDate(value: string | null | undefined): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : dates.formatDate(date);
}
function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? month : dates.formatMonth(date, { utc: true });
}
/** A percentage as shown: withheld reads <5 (a group under five is behind it), no source reads NA. */
export function percentLabel(row: PlacementStatisticsRowDto | null | undefined): string {
  if (!row) return 'NA';
  if (row.placementPercentage !== null && row.placementPercentage !== undefined) return `${row.placementPercentage}%`;
  return row.placed?.suppressed || row.applied?.suppressed ? '<5' : 'NA';
}
function ratioLabel(row: PlacementStatisticsRowDto): string {
  if (row.offersPerPlacedStudent !== null && row.offersPerPlacedStudent !== undefined) return String(row.offersPerPlacedStudent);
  return row.placed?.suppressed ? '<5' : 'NA';
}

/** Load the statistics once; null while loading or on failure (with the error). */
export function usePlacementStatistics(institutionId: string | undefined): { readonly data: PlacementStatisticsDto | null; readonly error: string } {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<{ data: PlacementStatisticsDto | null; error: string }>({ data: null, error: '' });
  useEffect(() => {
    if (!token || !institutionId) return undefined;
    const controller = new AbortController();
    setState({ data: null, error: '' });
    getPlacementStatistics(token, institutionId, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState(data && data.overall ? { data, error: '' } : { data: null, error: 'Placement statistics could not be loaded.' }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setState({ data: null, error: loadError(cause, 'Placement statistics could not be loaded.') }); });
    return () => controller.abort();
  }, [token, institutionId]);
  return state;
}

function StatisticsCells({ row }: { readonly row: PlacementStatisticsRowDto }): React.ReactElement {
  return <>
    <td>{suppressedCountLabel(row.eligible)}</td>
    <td>{suppressedCountLabel(row.notShared)}</td>
    <td>{suppressedCountLabel(row.applied)}</td>
    <td>{suppressedCountLabel(row.shortlisted)}</td>
    <td>{suppressedCountLabel(row.withOffer)}</td>
    <td>{suppressedCountLabel(row.placed)}</td>
    <td>{percentLabel(row)}</td>
    <td>{ratioLabel(row)}</td>
  </>;
}

/** Statistics by department and batch, with the season KPIs and the monthly offers trend. */
export function PlacementStatisticsSection({ institutionId, title = 'Placement statistics' }: { readonly institutionId: string; readonly title?: string }): React.ReactElement {
  const { data, error } = usePlacementStatistics(institutionId);
  const overall = data?.overall ?? null;
  return <section className="pilot-card" aria-label={title}>
    <div className="pilot-card-head"><h2>{title}</h2>{data ? <span className="pilot-chip slate">As of {formatDate(data.asOf.lastDay)}</span> : null}</div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!data && !error ? <p role="status">Loading placement statistics…</p> : null}
    <Kpis items={[
      ['Eligible', overall ? suppressedCountLabel(overall.eligible) : 'NA', 'blue', 'students'],
      ['Applied (shared)', overall ? suppressedCountLabel(overall.applied) : 'NA', 'indigo', 'opportunities'],
      ['With an offer', overall ? suppressedCountLabel(overall.withOffer) : 'NA', 'amber', 'offers'],
      ['Placed', overall ? suppressedCountLabel(overall.placed) : 'NA', 'green', 'placement'],
      ['Placed, of students sharing', percentLabel(overall), 'teal', 'reports'],
    ]} />
    {data ? (data.groups ?? []).length === 0
      ? <p>No students in your scope yet.</p>
      : <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Placement statistics by department and batch">
        <thead><tr><th scope="col">Department</th><th scope="col">Batch</th><th scope="col">Eligible</th><th scope="col">Not shared</th><th scope="col">Applied</th>
          <th scope="col">Shortlisted</th><th scope="col">With an offer</th><th scope="col">Placed</th><th scope="col">Placed, of students sharing</th><th scope="col">Offers per placed student</th></tr></thead>
        <tbody>
          {(data.groups ?? []).map((group) => <tr key={(group.department?.id ?? '-') + '|' + (group.batch?.id ?? '-')}>
            <th scope="row">{group.department?.name ?? 'No department'}</th><td>{group.batch?.name ?? 'No batch'}</td><StatisticsCells row={group} />
          </tr>)}
          <tr><th scope="row">All students in your scope</th><td /><StatisticsCells row={data.overall} /></tr>
        </tbody>
      </table></div> : null}
    {data ? <div className="pilot-legend" aria-label="Offers made by month">
      {(data.offersByMonth ?? []).map((entry) => <div key={entry.month}><i style={{ background: '#e5eaf2' }} /> Offers made in {monthLabel(entry.month)} <span className="num">{suppressedCountLabel(entry.offers)}</span></div>)}
    </div> : null}
    <ul className="role-check-list">
      <li>Counted only from applications students have chosen to share with the college. A student who shared nothing is "Not shared" — never counted as unplaced, and not in the placement percentage.</li>
      <li>Placed means an offer accepted or a hire. Figures stand at the end of the last full month, so a placement made this month appears next month.</li>
      <li>Any group of fewer than five reads &lt;5, and a total that would reveal one is withheld. Offer pay is never shown.</li>
    </ul>
  </section>;
}

/** Employers engaged and the drive calendar with outcomes for completed drives. */
export function PlacementRegisterSection({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<PlacementRegisterDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    getPlacementRegister(token, institutionId, controller.signal)
      .then((body) => { if (!controller.signal.aborted) { setData({ employers: body.employers ?? [], drives: body.drives ?? [] }); setError(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(loadError(cause, 'The placement register could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId]);
  return <section className="pilot-card" aria-label="Placement register">
    <div className="pilot-card-head"><h2>Placement register</h2></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!data && !error ? <p role="status">Loading the placement register…</p> : null}
    {data ? <>
      <h3>Employers engaged</h3>
      {data.employers.length === 0 ? <p>No employer has run an approved drive or addressed a job to your college yet.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Employers engaged">
          <thead><tr><th scope="col">Employer</th><th scope="col">Drives approved</th><th scope="col">Drives scheduled</th><th scope="col">Drives completed</th><th scope="col">Jobs addressed to the college</th><th scope="col">Last engaged</th></tr></thead>
          <tbody>{data.employers.map((employer) => <tr key={employer.name}>
            <th scope="row">{employer.name}</th><td>{employer.drives.approved}</td><td>{employer.drives.scheduled}</td><td>{employer.drives.completed}</td>
            <td>{employer.jobsAddressedToCollege}</td><td>{formatDate(employer.lastEngagedAt)}</td>
          </tr>)}</tbody>
        </table></div>}
      <h3>Drive calendar</h3>
      {data.drives.length === 0 ? <p>No drive has been approved yet.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Drive calendar">
          <thead><tr><th scope="col">Date</th><th scope="col">Employer</th><th scope="col">Job</th><th scope="col">Category</th><th scope="col">State</th><th scope="col">Students sharing</th><th scope="col">With an offer</th><th scope="col">Placed</th></tr></thead>
          <tbody>{data.drives.map((drive) => <tr key={drive.id}>
            <td>{formatDate(drive.scheduledStartAt ?? drive.proposedStartAt)}{drive.venueMode ? ` · ${venueModeLabels[drive.venueMode]}` : ''}</td>
            <th scope="row">{drive.employerName}</th>
            <td>{drive.opportunityTitle ?? 'Untitled'}</td>
            <td>{drive.category ? <span className="pilot-chip blue">{drive.category.name}{drive.category.retired ? ' (retired)' : ''}</span> : 'NA'}</td>
            <td><span className="hiring-tag">{campusDriveStateLabels[drive.state]}</span></td>
            {drive.outcome
              ? <><td>{suppressedCountLabel(drive.outcome.studentsSharing)}</td><td>{suppressedCountLabel(drive.outcome.withOffer)}</td><td>{suppressedCountLabel(drive.outcome.placed)}</td></>
              : <td colSpan={3}>After the drive completes</td>}
          </tr>)}</tbody>
        </table></div>}
      <p className="hiring-meta">Outcomes count only applications students shared with the college. Any group under five reads &lt;5.</p>
    </> : null}
  </section>;
}

/** The college's drive categories, for Settings: define, list and retire (with a reason). */
export function DriveCategoriesSection({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<{ categories: readonly DriveCategoryDto[]; canManage: boolean } | null>(null);
  const [loadFailure, setLoadFailure] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [retiring, setRetiring] = useState<DriveCategoryDto | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    listDriveCategories(token, institutionId, controller.signal)
      .then((body) => { if (!controller.signal.aborted) { setData({ categories: body.categories ?? [], canManage: body.canManage === true }); setLoadFailure(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setLoadFailure(formatApiError(cause, 'Drive categories could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId, reload]);
  if (!token) return <p role="status">Sign in to see drive categories.</p>;

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const rank = Number(form.get('rank') ?? 10);
    if (!name) { setError('Give the category a name.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await createDriveCategory(token, institutionId, { name, ...(description ? { description } : {}), rank });
      setNotice(`"${name}" can now be given to your campus drives.`);
      formElement.reset();
      setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'The category could not be added.')); } finally { setBusy(false); }
  }
  async function retire(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!retiring || !token) return;
    const reason = String(new FormData(event.currentTarget).get('reasonCode') ?? '');
    if (!reason) { setError('Choose a reason.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await retireDriveCategory(token, institutionId, retiring.id, reason as typeof driveCategoryRetireReasons[number]);
      setNotice(`"${retiring.name}" is retired. Drives already given it keep it; it can no longer be chosen.`);
      setRetiring(null); setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'The category could not be retired.')); } finally { setBusy(false); }
  }

  const active = (data?.categories ?? []).filter((category) => category.state === 'ACTIVE');
  const retired = (data?.categories ?? []).filter((category) => category.state === 'RETIRED');
  return <section className="role-card role-wide" aria-label="Drive categories">
    <h2>Drive categories</h2>
    <p>Your own labels for campus drives — for example Dream, Core or Mass. Only your college's staff see them; employers and students never do.</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loadFailure ? <p className="form-error" role="alert">{loadFailure}</p> : !data ? <p role="status">Loading drive categories…</p> : <>
      {active.length === 0 ? <p>No drive category is defined yet.</p>
        : <ul className="role-check-list">{active.map((category) => <li key={category.id}><strong>{category.name}</strong>{category.description ? ` — ${category.description}` : ''} <span className="hiring-meta">· order {category.rank}</span>
          {data.canManage ? <> <button type="button" className="secondary" disabled={busy} onClick={() => { setRetiring(category); setError(''); }}>Retire {category.name}</button></> : null}</li>)}</ul>}
      {retiring ? <form className="role-management-form" aria-label="Retire drive category" onSubmit={(event) => { void retire(event); }}>
        <label><span>Reason for retiring {retiring.name}</span><select name="reasonCode" defaultValue="">
          <option value="">Choose a reason</option>
          {driveCategoryRetireReasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
        </select></label>
        <div className="hiring-actions"><button type="submit" disabled={busy}>Confirm: retire</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setRetiring(null)}>Back</button></div>
      </form> : null}
      {data.canManage ? <form className="role-management-form" aria-label="Add drive category" onSubmit={(event) => { void create(event); }}>
        <label><span>Name</span><input name="name" maxLength={40} required /></label>
        <label><span>What it means (optional)</span><input name="description" maxLength={200} /></label>
        <label><span>Order in lists (1 first)</span><input name="rank" type="number" min={1} max={20} defaultValue={10} /></label>
        <button type="submit" disabled={busy}>Add category</button>
      </form> : <p className="hiring-meta">Defining categories needs a placement role for the whole college.</p>}
      {retired.length ? <details><summary>Retired categories</summary><ul className="role-check-list">
        {retired.map((category) => <li key={category.id}>{category.name} · retired {formatDate(category.retiredAt)} · {reasonLabel(category.retireReasonCode)}</li>)}
      </ul></details> : null}
    </>}
  </section>;
}

/** Load the college's active categories for the drive list; null when they cannot be read. */
export function useActiveDriveCategories(institutionId: string, reload = 0): readonly DriveCategoryDto[] | null {
  const token = getProtectedAccessToken();
  const [categories, setCategories] = useState<readonly DriveCategoryDto[] | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    listDriveCategories(token, institutionId, controller.signal)
      .then((body) => { if (!controller.signal.aborted) setCategories((body.categories ?? []).filter((category) => category.state === 'ACTIVE')); })
      .catch(() => { if (!controller.signal.aborted) setCategories(null); });
    return () => controller.abort();
  }, [token, institutionId, reload]);
  return categories;
}

/** A drive's category: a chip, or a picker for those who decide drives. */
export function DriveCategoryCell({ institutionId, driveId, current, categories, canSet, onChanged }: {
  readonly institutionId: string; readonly driveId: string; readonly current: DriveCategoryRefDto | null | undefined;
  readonly categories: readonly DriveCategoryDto[] | null; readonly canSet: boolean; readonly onChanged: (message: string, failed: boolean) => void;
}): React.ReactElement {
  const token = getProtectedAccessToken();
  const [busy, setBusy] = useState(false);
  const label = current ? `${current.name}${current.retired ? ' (retired)' : ''}` : 'NA';
  if (!canSet || !categories || categories.length === 0 || !token) return <span>{label}</span>;
  async function change(value: string): Promise<void> {
    if (!token) return;
    setBusy(true);
    try {
      const result = await setCampusDriveCategory(token, institutionId, driveId, value || null);
      onChanged(result.category ? `Category set to ${result.category.name}.` : 'Category cleared.', false);
    } catch (cause) { onChanged(formatApiError(cause, 'The category could not be changed.'), true); } finally { setBusy(false); }
  }
  return <label className="student-form-field"><span className="sr-only">Category</span>
    <select aria-label="Drive category" value={current && !current.retired ? current.id : ''} disabled={busy} onChange={(event) => { void change(event.target.value); }}>
      <option value="">{current?.retired ? label : 'No category'}</option>
      {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
    </select></label>;
}
