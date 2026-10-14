/**
 * ONE · Role portal — Institution — the placement officer's home (re-skin phase 6)
 *
 * The Placement Dashboard in the approved Momentum composition (inventory
 * 06-screens/placement-officer.html): campus drives and where each stands, the offers trend,
 * the institution's band distribution, assessments, the placement pipeline and the employers
 * engaged. It replaces the earlier pilot-parity dashboard, which printed "NA" in slots it had no
 * source for (the cohort band strip, department readiness) and drew an average-style readiness
 * widget.
 *
 * Every figure comes from a read this role already makes: the roster, campus drives, season
 * statistics, the placement register, assessments and the department overview (which the server
 * scopes to the placement office). A block renders only when its read succeeded; counts of
 * people go through <SmallCount>; readiness is a band distribution only.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon.js';
import {
  getDepartmentOverview,
  getProtectedAccessToken,
  listInstitutionExamResults,
  listInstitutionExams,
  listInstitutionStudents,
  type DepartmentOverviewDto,
  type ExamNotAttemptedDto,
  type InstitutionExamDto,
  type InstitutionStudentDto,
} from '../api.js';
import { campusDriveStateLabels, listInstitutionCampusDrives, venueModeLabels, type CampusDriveDto } from '../api/campusDrives.js';
import { getPlacementRegister, getPlacementStatistics, type PlacementRegisterDto, type PlacementStatisticsDto } from '../api/placementRegister.js';
import { formatDate, formatMonth } from '../dates.js';
import { SmallCount, SuppressedLegend, isSmallCount, partitionNeedsRanges, shownCount } from '../momentum/smallCount.js';
import { StatusTag } from '../momentum/statusTag.js';
import { Loading } from '../momentum/loader.js';
import {
  CohortBandsCard, IhAvatar, IhCard, IhKpis, IhNote, IhPage, IhTiles, NeedsAttentionCard, PeopleCount, RecordCount, go, shortDate, shortTime, validOverview,
} from './institutionMomentum.js';

type NotAttempted = ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string };

interface PlacementHomeData {
  readonly students: readonly InstitutionStudentDto[] | null;
  readonly exams: readonly InstitutionExamDto[] | null;
  readonly drives: readonly CampusDriveDto[] | null;
  readonly placement: PlacementStatisticsDto | null;
  readonly register: PlacementRegisterDto | null;
  readonly overview: DepartmentOverviewDto | null;
  readonly notAttempted: readonly NotAttempted[];
}

const OPEN_DRIVE_STATES = new Set(['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED']);
const STEPS = ['Requested', 'Approved', 'Date confirmed', 'Drive day', 'Completed'] as const;

/** Where a drive stands on the approved lifecycle: the index of its current step. */
function driveStep(drive: CampusDriveDto, now: number): number {
  if (drive.state === 'COMPLETED') return 4;
  if (drive.state === 'SCHEDULED') return drive.scheduledStartAt && Date.parse(drive.scheduledStartAt) <= now ? 3 : 2;
  if (drive.state === 'APPROVED') return 1;
  return 0;
}

/** The drive to feature: the next scheduled one, else one approved and waiting for a date, else the oldest request. */
function featuredDrive(drives: readonly CampusDriveDto[], now: number): CampusDriveDto | null {
  const at = (value: string | null) => (value ? Date.parse(value) : Number.MAX_SAFE_INTEGER);
  const scheduled = drives.filter((drive) => drive.state === 'SCHEDULED' && at(drive.scheduledStartAt) >= now).sort((a, b) => at(a.scheduledStartAt) - at(b.scheduledStartAt));
  const approved = drives.filter((drive) => drive.state === 'APPROVED').sort((a, b) => at(a.proposedStartAt) - at(b.proposedStartAt));
  const requested = drives.filter((drive) => drive.state === 'REQUESTED' || drive.state === 'CHANGES_REQUESTED').sort((a, b) => at(a.createdAt) - at(b.createdAt));
  return scheduled[0] ?? approved[0] ?? requested[0] ?? null;
}

async function loadPlacementHome(token: string, institutionId: string, signal: AbortSignal): Promise<PlacementHomeData> {
  const [roster, exams, drives, placement, register, overview] = await Promise.all([
    listInstitutionStudents(token, institutionId, signal).catch(() => null),
    listInstitutionExams(token, institutionId, signal).then((response) => (Array.isArray(response?.assessments) ? response.assessments : null)).catch(() => null),
    listInstitutionCampusDrives(token, institutionId, {}, signal).then((response) => (Array.isArray(response?.drives) ? response.drives : null)).catch(() => null),
    getPlacementStatistics(token, institutionId, signal).then((response) => (response && response.overall ? response : null)).catch(() => null),
    getPlacementRegister(token, institutionId, signal).then((response) => (response && Array.isArray(response.employers) ? response : null)).catch(() => null),
    getDepartmentOverview(token, institutionId, signal).then(validOverview).catch(() => null),
  ]);
  const target = exams?.find((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0) ?? null;
  const notAttempted = target
    ? await listInstitutionExamResults(token, institutionId, target.id, signal)
      .then((response) => response.notAttempted.map((entry) => ({ ...entry, examTitle: target.title, endsAt: target.endsAt }))).catch(() => [])
    : [];
  return { students: Array.isArray(roster?.students) ? roster.students : null, exams, drives, placement, register, overview, notAttempted };
}

function DrivesCard({ drives }: { readonly drives: readonly CampusDriveDto[] }): React.ReactElement {
  const now = Date.now();
  const drive = featuredDrive(drives, now);
  const waiting = drives.filter((item) => item.state === 'REQUESTED').length;
  const toConfirm = drives.filter((item) => item.state === 'APPROVED').length;
  const ahead = drives.filter((item) => item.state === 'SCHEDULED' && item.scheduledStartAt && Date.parse(item.scheduledStartAt) >= now).length;
  const others = drives.filter((item) => item !== drive && OPEN_DRIVE_STATES.has(item.state)).slice(0, 3);
  const when = drive ? drive.scheduledStartAt ?? drive.proposedStartAt : null;
  const whenDate = when ? new Date(when) : null;
  const step = drive ? driveStep(drive, now) : -1;
  return <IhCard title="Campus drives" aside={toConfirm || ahead ? `${toConfirm + ahead} approved` : ''}>
    {drive ? <div className="ih-drive">
      <div className="ih-drive-h">
        {whenDate ? <span className="ih-cal" aria-hidden="true"><b>{whenDate.getDate()}</b><small>{whenDate.toLocaleDateString('en-GB', { month: 'short' })}</small></span> : null}
        <div>
          <b>{drive.opportunityTitle ?? drive.employerName}</b>
          <small>{[drive.opportunityTitle ? drive.employerName : null, drive.venueMode ? venueModeLabels[drive.venueMode] : null,
            when ? `${drive.scheduledStartAt ? '' : 'Proposed '}${formatDate(when)}${shortTime(when) ? `, ${shortTime(when)}` : ''}` : null,
            drive.applicationDeadline ? `Applications close ${formatDate(drive.applicationDeadline)}` : null].filter(Boolean).join(' · ')}</small>
          {drive.employerNote ? <small>“{drive.employerNote}”</small> : null}
        </div>
        <StatusTag state={drive.state} label={campusDriveStateLabels[drive.state]} />
      </div>
      <ol className="ih-steps" aria-label="Where this drive stands">
        {STEPS.map((label, index) => <li key={label} className={index < step ? 'd' : index === step ? 'c' : undefined} {...(index === step ? { 'aria-current': 'step' as const } : {})}>{label}</li>)}
      </ol>
    </div> : <p className="ih-empty">No campus drive is open. Employers request drives from their job listings; each request waits here for your decision.</p>}
    <div className="ih-tiles ih-drive-tiles" style={{ '--cols': 3 } as React.CSSProperties}>
      <div className={`ih-tile${waiting ? '' : ' z'}`}><span className="ih-tile-l">Requests waiting for you</span><b className="num"><RecordCount value={waiting} /></b></div>
      <div className={`ih-tile${toConfirm ? '' : ' z'}`}><span className="ih-tile-l">Approved, date to confirm</span><b className="num"><RecordCount value={toConfirm} /></b></div>
      <div className={`ih-tile${ahead ? '' : ' z'}`}><span className="ih-tile-l">Scheduled ahead</span><b className="num"><RecordCount value={ahead} /></b></div>
    </div>
    {others.length ? <ul className="ih-list">{others.map((item) => <li key={item.id} className="ih-li">
      <IhAvatar name={item.employerName} />
      <div className="ih-li-t"><b>{item.opportunityTitle ?? item.employerName}</b><small>{[item.employerName, shortDate(item.scheduledStartAt ?? item.proposedStartAt)].filter(Boolean).join(' · ')}</small></div>
      <StatusTag state={item.state} label={campusDriveStateLabels[item.state]} />
    </li>)}</ul> : null}
    <IhNote>A drive reaches students only once you approve it. Students decide whether to share their application with the college.</IhNote>
  </IhCard>;
}

/** Offers by month: bars only when every month has five or more; otherwise each month reads its count or "<5". */
function OffersTrendCard({ placement }: { readonly placement: PlacementStatisticsDto }): React.ReactElement {
  const months = placement.offersByMonth;
  const allShown = months.length > 0 && months.every((entry) => !isSmallCount(entry.offers));
  const max = Math.max(1, ...months.map((entry) => shownCount(entry.offers) ?? 0));
  return <IhCard title="Offers trend" aside={months.length ? `Last ${months.length} ${months.length === 1 ? 'month' : 'months'}` : ''}>
    {!months.length ? <p className="ih-empty">No offer months are recorded yet.</p>
      : allShown ? <ol className="ih-trend" aria-label="Offers by month">{months.map((entry, index) => <li key={entry.month} style={{ '--k': index } as React.CSSProperties}>
        <span className="ih-trend-v num"><SmallCount value={entry.offers} /></span>
        <i aria-hidden="true" style={{ height: `${Math.round(((shownCount(entry.offers) ?? 0) / max) * 100)}%` }} />
        <small>{formatMonth(`${entry.month}-01T00:00:00`)}</small>
      </li>)}</ol>
        : <>
          <p className="ih-lead"><b>Not enough data yet.</b> A month with fewer than five offers has no figure to plot, so the line appears once every month reaches five.</p>
          <ul className="ih-months" aria-label="Offers by month">{months.map((entry) => <li key={entry.month}><small>{formatMonth(`${entry.month}-01T00:00:00`)}</small><b><SmallCount value={entry.offers} /></b></li>)}</ul>
        </>}
    <IhNote icon="info">From applications students chose to share. Offer pay is never shown.</IhNote>
  </IhCard>;
}

function PipelineCard({ placement }: { readonly placement: PlacementStatisticsDto }): React.ReactElement {
  const overall = placement.overall;
  const anySmall = [overall.eligible, overall.applied, overall.shortlisted, overall.withOffer, overall.placed].some((count) => isSmallCount(count));
  return <IhCard title="Placement pipeline" aside={`As of ${formatDate(placement.asOf.lastDay)}`}>
    <IhTiles columns={5} tiles={[
      { key: 'eligible', icon: 'student-search', label: 'Eligible', value: <SmallCount value={overall.eligible} /> },
      { key: 'applied', icon: 'applications', label: 'Applied (shared)', value: <SmallCount value={overall.applied} /> },
      { key: 'shortlisted', icon: 'tasks', label: 'Shortlisted', value: <SmallCount value={overall.shortlisted} /> },
      { key: 'offer', icon: 'offers', label: 'With an offer', value: <SmallCount value={overall.withOffer} /> },
      { key: 'placed', icon: 'placement', label: 'Placed', value: <SmallCount value={overall.placed} /> },
    ]} />
    {placement.groups.length ? <div className="ih-table-wrap ih-gap"><table className="ih-table"><caption className="sr-only">Placement by department and batch</caption>
      <thead><tr><th scope="col">Department</th><th scope="col">Batch</th><th scope="col" className="r">Eligible</th><th scope="col" className="r">Not shared</th><th scope="col" className="r">Applied</th><th scope="col" className="r">Offers</th></tr></thead>
      <tbody>{placement.groups.map((group, index) => <tr key={`${group.department?.id ?? 'none'}:${group.batch?.id ?? index}`}>
        <th scope="row"><b>{group.department?.name ?? 'No department'}</b></th><td className="ih-muted">{group.batch?.name ?? 'No batch'}</td>
        <td className="r num"><SmallCount value={group.eligible} /></td><td className="r num"><SmallCount value={group.notShared} /></td>
        <td className="r num"><SmallCount value={group.applied} /></td><td className="r num"><SmallCount value={group.withOffer} /></td>
      </tr>)}</tbody></table></div> : null}
    {anySmall ? <SuppressedLegend>Stages carry no size cue: a group under five reads “&lt;5”.</SuppressedLegend> : null}
    <IhNote>Counted only from applications students chose to share. “Not shared” is never counted as unplaced. Any group under five reads “&lt;5”; a total that would expose one is withheld.</IhNote>
  </IhCard>;
}

function EmployersCard({ register }: { readonly register: PlacementRegisterDto }): React.ReactElement {
  const employers = [...register.employers].sort((a, b) => Date.parse(b.lastEngagedAt ?? '') - Date.parse(a.lastEngagedAt ?? '') || a.name.localeCompare(b.name));
  const approved = register.employers.reduce((sum, employer) => sum + employer.drives.approved, 0);
  const completed = register.employers.reduce((sum, employer) => sum + employer.drives.completed, 0);
  return <IhCard title="Employers engaged">
    {employers.length ? <ul className="ih-list">{employers.slice(0, 4).map((employer) => {
      const drives = employer.drives.approved + employer.drives.scheduled;
      return <li key={employer.name} className="ih-li">
        <IhAvatar name={employer.name} />
        <div className="ih-li-t"><b>{employer.name}</b><small>{[shortDate(employer.lastEngagedAt) ? `Last engaged ${formatDate(employer.lastEngagedAt)}` : null,
          employer.jobsAddressedToCollege ? `${employer.jobsAddressedToCollege} ${employer.jobsAddressedToCollege === 1 ? 'job' : 'jobs'} addressed to the college` : null].filter(Boolean).join(' · ')}</small></div>
        {drives ? <span className="tag t-band"><i />{drives} {drives === 1 ? 'drive' : 'drives'}</span> : null}
      </li>;
    })}</ul> : <p className="ih-empty">No employer has engaged with the college yet.</p>}
    {employers.length ? <IhTiles columns={2} tiles={[
      { key: 'approved', label: 'Drives approved', value: <RecordCount value={approved} />, muted: approved === 0 },
      { key: 'completed', label: 'Drives completed', value: <RecordCount value={completed} />, muted: completed === 0 },
    ]} /> : null}
    <IhNote>Employers see only what students choose to share. Readiness bands and offer pay are never shown to them.</IhNote>
  </IhCard>;
}

export function PlacementOfficerHome({ institutionId, basePath, title = 'Placement Dashboard' }: { readonly institutionId: string; readonly basePath: string; readonly title?: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<PlacementHomeData | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    setData(null);
    void loadPlacementHome(token, institutionId, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); });
    return () => controller.abort();
  }, [token, institutionId]);

  const students = data?.students ?? null;
  const active = students ? students.filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE').length : null;
  const activeRanged = students && active !== null ? partitionNeedsRanges([active, students.length - active]) : false;
  const overall = data?.placement?.overall ?? null;
  const drives = data?.drives ?? null;
  const approvedDrives = drives ? drives.filter((drive) => ['APPROVED', 'SCHEDULED', 'COMPLETED'].includes(drive.state)).length : null;
  const toConfirm = drives ? drives.filter((drive) => drive.state === 'APPROVED').length : 0;
  const readiness = data?.overview?.readiness.aggregate && data.overview.readiness.month ? data.overview.readiness : null;
  const published = data?.exams ? data.exams.filter((exam) => exam.lifecycleState === 'PUBLISHED').length : null;
  const asOf = data?.placement ? `As of ${formatDate(data.placement.asOf.lastDay)}` : null;

  return <IhPage title={title} summary="Campus drives, who is eligible, and where the cohort stands before the season opens.">
    {!data ? <Loading className="ih-empty">Loading the placement dashboard…</Loading> : null}
    <IhKpis items={[
      students !== null && active !== null && { key: 'active', icon: 'students', value: <PeopleCount value={active} range={activeRanged} />, label: 'Active students', note: <>of <SmallCount value={students.length} /> on the roster</> },
      overall && { key: 'eligible', icon: 'student-search', value: <SmallCount value={overall.eligible} />, label: 'Placement eligible', note: isSmallCount(overall.eligible) ? 'Too few to show' : asOf },
      approvedDrives !== null && { key: 'drives', icon: 'placement', value: <RecordCount value={approvedDrives} />, label: approvedDrives === 1 ? 'Drive approved' : 'Drives approved', note: toConfirm ? `${toConfirm} ${toConfirm === 1 ? 'date' : 'dates'} to confirm` : null },
      overall && { key: 'offers', icon: 'offers', value: <SmallCount value={overall.withOffer} />, label: 'With offers', note: 'From shared applications' },
      overall && { key: 'placed', icon: 'placement', value: <SmallCount value={overall.placed} />, label: 'Placed', note: isSmallCount(overall.placed) ? 'Too few to show' : asOf },
    ]} />
    <div className="ih-grid">
      {drives ? <div className="ih-c8"><DrivesCard drives={drives} /></div> : null}
      {data?.placement ? <div className={drives ? 'ih-c4' : 'ih-c12'}><OffersTrendCard placement={data.placement} /></div> : null}
      {readiness ? <div className="ih-c8"><CohortBandsCard title="Readiness" aggregate={readiness.aggregate!} month={readiness.month}
        link={{ label: 'Readiness', onClick: () => go(`${basePath}/readiness`) }} /></div> : null}
      {data?.exams && published !== null ? <div className={`${readiness ? 'ih-c4' : 'ih-c12'} ih-col`}>
        <IhCard title="Assessments" link={{ label: 'Open', onClick: () => go(`${basePath}/assessments`) }}>
          {published === 0 ? <div className="ih-calm">
            <span className="ih-calm-i" aria-hidden="true"><Icon name="assessments" size={24} /></span>
            <b>No assessments published yet</b>
            <small>Publish one before a drive, so shortlists rest on fresh evidence.</small>
            <button type="button" className="pilot-btn small" onClick={() => go(`${basePath}/assessments`)}><Icon name="plus" size={16} /> Create an assessment</button>
          </div> : <IhTiles columns={2} tiles={[
            { key: 'published', label: 'Published', value: <RecordCount value={published} /> },
            { key: 'draft', label: 'Not published', value: <RecordCount value={data.exams.length - published} />, muted: data.exams.length === published },
          ]} />}
        </IhCard>
        {data.notAttempted.length ? <NeedsAttentionCard entries={data.notAttempted} onOpen={() => go(`${basePath}/assessments`)} /> : null}
      </div> : null}
      {data?.placement ? <div className="ih-c8"><PipelineCard placement={data.placement} /></div> : null}
      {data?.register ? <div className={data.placement ? 'ih-c4' : 'ih-c12'}><EmployersCard register={data.register} /></div> : null}
    </div>
  </IhPage>;
}
