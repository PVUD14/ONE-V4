/**
 * ONE · Role portal — Institution — Settings, academic calendar and staff profile (INST-05)
 *
 * The screens behind existing navigation labels that were empty (defect I-6): the admin's
 * Settings (college profile, grading scales, calendar, and honest "Not built yet" sections
 * for placement policies and data-processing terms), the department head's Settings (their
 * own profile and notification preferences, and the college settings read-only), the
 * faculty member's Profile and Settings, and the academic calendar above the meetings on the
 * faculty Calendar. No navigation item is added, removed or renamed.
 *
 * Whether the viewer may edit is always the server's answer (canEdit); nothing is filtered or
 * decided here. The details AI8HT operations verified are shown read-only. A programme
 * without a grading scale reads NA — never a guessed scale. Real data only.
 */
import { useEffect, useState } from 'react';
import {
  academicTermKindLabels,
  archiveAcademicTerm,
  createAcademicTerm,
  getInstitutionSettings,
  getProtectedAccessToken,
  getStaffProfile,
  institutionResultScaleLabels,
  listAcademicTerms,
  removeProgrammeGradingScale,
  setProgrammeGradingScale,
  updateAcademicTerm,
  updateInstitutionSettings,
  updateStaffNotificationPreferences,
} from '../api.js';
import type { AcademicTermDto, AcademicTermKind, AcademicTermListDto, InstitutionResultScale, InstitutionSettingsDto, NotificationPreferencesDto, StaffProfileDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { InstitutionWorkspaceError, RestrictedApiState, formatApiError, isInstitutionStaffWorkspace } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { PlacementPoliciesSection } from './institutionCampusDrives.js';
import { DriveCategoriesSection } from './institutionPlacementRegister.js';

const notProvided = 'Not provided';

const verificationLabels: Readonly<Record<string, string>> = {
  PENDING: 'Awaiting review', UNDER_REVIEW: 'Under review', VERIFIED: 'Verified', REJECTED: 'Not approved', SUSPENDED: 'Suspended',
};

const institutionTypeLabels: Readonly<Record<string, string>> = {
  UNIVERSITY: 'University', ENGINEERING_COLLEGE: 'Engineering college', ARTS_SCIENCE_COLLEGE: 'Arts and science college',
  BUSINESS_SCHOOL: 'Business school', POLYTECHNIC: 'Polytechnic', OTHER: 'Other',
};

const roleLabels: Readonly<Record<string, string>> = {
  INSTITUTION_OWNER: 'Institution owner', INSTITUTION_ADMIN: 'Institution admin', PLACEMENT_ADMIN: 'Placement officer',
  DEPARTMENT_HEAD: 'Department head', FACULTY_LECTURER: 'Faculty',
};

/** Why a programme's grading scale is removed; recorded with it. */
export const gradingScaleRemoveReasons = [
  ['WRONG_SCALE', 'Set in error'],
  ['PROGRAMME_CLOSED', 'Programme no longer offered'],
  ['REGULATION_CHANGED', 'Regulations changed'],
] as const;

/** Why a calendar entry is archived; recorded with it. */
export const academicTermArchiveReasons = [
  ['CANCELLED', 'Cancelled'],
  ['DUPLICATE', 'Entered twice'],
  ['CORRECTION', 'Entered in error'],
] as const;

function formatDate(value: string | null | undefined): string {
  if (!value) return 'NA';
  const date = new Date(value.length === 10 ? value + 'T00:00:00' : value);
  return Number.isNaN(date.getTime()) ? 'NA' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1439 ? minutes : null;
}

function location(profile: InstitutionSettingsDto['profile']): string {
  return [profile.city, profile.stateOrProvince, profile.countryCode].filter(Boolean).join(', ') || notProvided;
}

function scaleLabel(scale: InstitutionResultScale | null | undefined): string {
  return scale ? institutionResultScaleLabels[scale] : 'NA';
}

// --- College settings -------------------------------------------------------------------

/**
 * Institution admin "Settings" (edit) and department head "Settings" (read-only college
 * settings under the head's own profile and preferences). The server decides canEdit.
 */
export function InstitutionSettingsPage({ authenticatedWorkspace, personal = false }: {
  readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined;
  /** Department head: show the reader's own profile and notification preferences first. */
  readonly personal?: boolean;
}): React.ReactElement {
  const token = getProtectedAccessToken();
  if (!token) return <RestrictedApiState title="Settings" message="Sign in to your institution workspace to see its settings." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Settings" />;
  const institutionId = authenticatedWorkspace.organizationId;
  return <StaffPilotWrap title="Settings" subtitle={personal
    ? 'Your profile and notifications, and your college settings as its administrators have set them.'
    : 'Your college profile, grading scales and academic calendar.'}>
    {personal ? <><StaffProfileSection key={'profile:' + institutionId} token={token} institutionId={institutionId} />
      <NotificationPreferencesSection key={'prefs:' + institutionId} token={token} institutionId={institutionId} /></> : null}
    <CollegeSettingsSections key={'settings:' + institutionId} token={token} institutionId={institutionId} />
    <AcademicCalendarPanel key={'calendar:' + institutionId} token={token} institutionId={institutionId} />
    {!personal ? <>
      {/* EMP-11: the college's placement policies, enforced at apply for its campus drives. */}
      <PlacementPoliciesSection key={'policies:' + institutionId} institutionId={institutionId} />
      {/* INST-12: the college's own drive categories (Dream, Core, Mass…), set here and given to drives. */}
      <DriveCategoriesSection key={'categories:' + institutionId} institutionId={institutionId} />
      <div className="role-wide" aria-label="Data-processing terms"><V2EmptyState icon="📄" title="Data-processing terms — not built yet"
        note="Versioned data-processing terms, the college data export and exit are not built yet. Nothing has been accepted on your college's behalf."
        hint="Contact AI8HT operations about your agreement in the meantime." /></div>
    </> : null}
  </StaffPilotWrap>;
}

function CollegeSettingsSections({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [settings, setSettings] = useState<InstitutionSettingsDto | null>(null);
  const [draft, setDraft] = useState({ about: '', placementContactEmail: '' });
  const [scaleDrafts, setScaleDrafts] = useState<Record<string, { scale: string; passThreshold: string }>>({});
  const [removeReason, setRemoveReason] = useState<string>(gradingScaleRemoveReasons[0][0]);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  function adopt(next: InstitutionSettingsDto): void {
    setSettings(next);
    setDraft({ about: next.college.about ?? '', placementContactEmail: next.college.placementContactEmail ?? '' });
    setScaleDrafts(Object.fromEntries(next.programmes.map((programme) => [programme.programUnitId, {
      scale: programme.gradingScale?.scale ?? '', passThreshold: programme.gradingScale?.passThreshold === null || programme.gradingScale?.passThreshold === undefined ? '' : String(programme.gradingScale.passThreshold),
    }])));
  }

  useEffect(() => {
    const controller = new AbortController();
    getInstitutionSettings(token, institutionId, controller.signal)
      .then(({ settings: loaded }) => { if (!controller.signal.aborted) { adopt(loaded); setLoadError(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'Your college settings could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId]);

  async function reload(): Promise<void> {
    const { settings: loaded } = await getInstitutionSettings(token, institutionId);
    adopt(loaded);
  }

  async function saveCollege(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!settings) return;
    const changes: Record<string, string | null> = {};
    if (draft.about.trim() !== (settings.college.about ?? '')) changes.about = draft.about.trim() || null;
    if (draft.placementContactEmail.trim() !== (settings.college.placementContactEmail ?? '')) changes.placementContactEmail = draft.placementContactEmail.trim() || null;
    if (!Object.keys(changes).length) { setNotice('Nothing to save.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { settings: saved } = await updateInstitutionSettings(token, institutionId, changes);
      adopt(saved);
      setNotice('College profile saved.');
    } catch (cause) {
      setError(formatApiError(cause, 'The college profile could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function saveScale(programUnitId: string, programName: string): Promise<void> {
    const entry = scaleDrafts[programUnitId];
    if (!entry?.scale) { setError('Choose a grading scale first.'); return; }
    const threshold = entry.passThreshold.trim();
    setBusy(true); setError(''); setNotice('');
    try {
      await setProgrammeGradingScale(token, institutionId, {
        programUnitId, scale: entry.scale as InstitutionResultScale, ...(threshold ? { passThreshold: Number(threshold) } : {}),
      });
      await reload();
      setNotice(`Grading scale saved for ${programName}.`);
    } catch (cause) {
      setError(formatApiError(cause, 'The grading scale could not be saved. Pass marks fit the scale (up to 10, 4 or 100); letter and pass/fail scales take none.'));
    } finally {
      setBusy(false);
    }
  }

  async function removeScale(programUnitId: string, programName: string): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try {
      await removeProgrammeGradingScale(token, institutionId, programUnitId, removeReason);
      await reload();
      setNotice(`Grading scale removed for ${programName}. It now reads NA until a scale is set.`);
    } catch (cause) {
      setError(formatApiError(cause, 'The grading scale could not be removed.'));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="form-error role-wide" role="alert">{loadError}</p>;
  if (!settings) return <p className="role-wide" role="status">Loading your college settings…</p>;
  const { profile, college } = settings;
  const withScale = settings.programmes.filter((programme) => programme.gradingScale).length;
  const numericMaximum = settings.options.numericScaleMaximum;

  return <>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🛡️" tone="teal" value={verificationLabels[profile.verificationState] ?? 'NA'} label="Verification" />
      <V2Stat icon="🏫" tone="blue" value={profile.institutionType ? institutionTypeLabels[profile.institutionType] ?? 'NA' : 'NA'} label="Institution type" />
      <V2Stat icon="📏" tone="amber" value={settings.programmes.length ? `${withScale} of ${settings.programmes.length}` : '0'} label="Programmes with a grading scale" />
      <V2Stat icon="🕒" tone="purple" value={formatDate(college.updatedAt)} label="Profile last updated" />
    </div>
    {notice ? <p className="role-api-success role-wide" role="status">{notice}</p> : null}
    {error ? <p className="form-error role-wide" role="alert">{error}</p> : null}

    <section className="role-card role-wide" aria-label="Verified details">
      <h2>Verified details</h2>
      <p>Managed by AI8HT operations. These are what your college was verified against, so they change only through operations.</p>
      <div className="role-record-table-wrap"><table className="role-record-table"><tbody>
        <tr><th scope="row">Legal name</th><td>{profile.legalName}</td></tr>
        <tr><th scope="row">Display name</th><td>{profile.displayName ?? notProvided}</td></tr>
        <tr><th scope="row">Website</th><td>{profile.websiteUrl ?? notProvided}</td></tr>
        <tr><th scope="row">Location</th><td>{location(profile)}</td></tr>
        <tr><th scope="row">Address</th><td>{[profile.addressLine1, profile.addressLine2, profile.postalCode].filter(Boolean).join(', ') || notProvided}</td></tr>
        <tr><th scope="row">Contact email</th><td>{profile.primaryContactEmail ?? notProvided}</td></tr>
      </tbody></table></div>
    </section>

    {settings.canEdit ? <form className="role-card role-wide role-management-form" aria-label="College profile" onSubmit={(event) => void saveCollege(event)}>
      <h2>College profile</h2>
      <label><span>About the college</span><textarea value={draft.about} maxLength={2000} rows={4}
        onChange={(event) => setDraft((value) => ({ ...value, about: event.target.value }))} /></label>
      <label><span>Placement office email</span><input type="email" value={draft.placementContactEmail} maxLength={254}
        onChange={(event) => setDraft((value) => ({ ...value, placementContactEmail: event.target.value }))} /></label>
      <button type="submit" disabled={busy}>Save college profile</button>
    </form> : <section className="role-card role-wide" aria-label="College profile">
      <h2>College profile</h2>
      <p>{college.about ?? 'No description yet.'}</p>
      <p className="hiring-meta">Placement office email: {college.placementContactEmail ?? notProvided}</p>
      <p className="hiring-meta">Set by your institution's owners and admins.</p>
    </section>}

    <section className="role-card role-wide" aria-label="Grading scales">
      <h2>Grading scales</h2>
      <p>The scale each programme's results are issued on, and its pass mark. A programme without a scale shows NA wherever a scale is needed — ONE never assumes one.</p>
      {settings.programmes.length === 0 ? <p>No programmes are set up yet. Add programmes under Academic Structure, then set their grading scales here.</p> : null}
      {settings.canEdit && settings.programmes.some((programme) => programme.gradingScale) ? <label><span>Reason for removing a scale</span>
        <select value={removeReason} onChange={(event) => setRemoveReason(event.target.value)}>{gradingScaleRemoveReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label> : null}
      {settings.programmes.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Programme grading scales</caption>
        <thead><tr><th>Programme</th><th>Scale</th><th>Pass mark</th>{settings.canEdit ? <th>Change</th> : null}</tr></thead>
        <tbody>{settings.programmes.map((programme) => {
          const entry = scaleDrafts[programme.programUnitId] ?? { scale: '', passThreshold: '' };
          const maximum = entry.scale ? numericMaximum[entry.scale as InstitutionResultScale] : undefined;
          return <tr key={programme.programUnitId}>
            <th scope="row"><strong>{programme.programName}</strong>{programme.parentName ? <span>{programme.parentName}</span> : null}</th>
            <td>{scaleLabel(programme.gradingScale?.scale)}</td>
            <td>{programme.gradingScale?.passThreshold ?? 'NA'}</td>
            {settings.canEdit ? <td><div className="role-record-actions">
              <label><span className="sr-only">Scale for {programme.programName}</span>
                <select aria-label={`Scale for ${programme.programName}`} value={entry.scale}
                  onChange={(event) => setScaleDrafts((value) => ({ ...value, [programme.programUnitId]: { scale: event.target.value, passThreshold: numericMaximum[event.target.value as InstitutionResultScale] === undefined ? '' : entry.passThreshold } }))}>
                  <option value="">Choose a scale</option>
                  {settings.options.scales.map((scale) => <option key={scale} value={scale}>{institutionResultScaleLabels[scale]}</option>)}
                </select></label>
              {maximum !== undefined ? <label><span className="sr-only">Pass mark for {programme.programName}</span>
                <input aria-label={`Pass mark for ${programme.programName}`} type="number" min={0} max={maximum} step="0.001" value={entry.passThreshold}
                  placeholder={`0–${maximum}`} onChange={(event) => setScaleDrafts((value) => ({ ...value, [programme.programUnitId]: { ...entry, passThreshold: event.target.value } }))} /></label> : null}
              <button type="button" disabled={busy} onClick={() => void saveScale(programme.programUnitId, programme.programName)}>Save scale</button>
              {programme.gradingScale ? <button type="button" className="secondary" disabled={busy} onClick={() => void removeScale(programme.programUnitId, programme.programName)}>Remove scale</button> : null}
            </div></td> : null}
          </tr>;
        })}</tbody></table></div> : null}
    </section>
  </>;
}

// --- Academic calendar ------------------------------------------------------------------

const emptyTerm = { name: '', kind: 'TERM' as AcademicTermKind, startsOn: '', endsOn: '', unitId: '' };

/**
 * The college's academic calendar. Every institution staff role reads it; owners and admins
 * (canEdit, from the server) add, correct and archive entries.
 */
export function AcademicCalendarPanel({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [data, setData] = useState<AcademicTermListDto | null>(null);
  const [form, setForm] = useState(emptyTerm);
  const [editing, setEditing] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState<string>(academicTermArchiveReasons[0][0]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listAcademicTerms(token, institutionId, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(loaded?.terms)) { setError('The academic calendar could not be loaded.'); return; }
        setData(loaded);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'The academic calendar could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId, reload]);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(''); setNotice('');
    const body = { name: form.name.trim(), kind: form.kind, startsOn: form.startsOn, endsOn: form.endsOn, unitId: form.unitId || null };
    try {
      if (editing) await updateAcademicTerm(token, institutionId, editing, body);
      else await createAcademicTerm(token, institutionId, body);
      setNotice(editing ? 'Calendar entry updated.' : 'Calendar entry added.');
      setForm(emptyTerm); setEditing(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The calendar entry could not be saved. Check the name, the dates (end on or after start, at most 400 days) and what it applies to.'));
    }
  }

  function edit(term: AcademicTermDto): void {
    setEditing(term.id);
    setForm({ name: term.name, kind: term.kind, startsOn: term.startsOn, endsOn: term.endsOn, unitId: term.unit?.id ?? '' });
  }

  async function archive(term: AcademicTermDto): Promise<void> {
    setError(''); setNotice('');
    try {
      await archiveAcademicTerm(token, institutionId, term.id, archiveReason);
      setNotice(`${term.name} archived. It no longer shows on the calendar.`);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The calendar entry could not be archived.'));
    }
  }

  const terms = data?.terms ?? [];
  const current = terms.filter((term) => term.current);
  return <section className="role-card role-wide" aria-label="Academic calendar">
    <h2>Academic calendar</h2>
    <p>Terms, examination periods and breaks, as your college has set them.{current.length ? ` Now: ${current.map((term) => term.name).join(', ')}.` : ''}</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {data?.canEdit ? <form className="role-management-form" aria-label={editing ? 'Edit calendar entry' : 'Add calendar entry'} onSubmit={(event) => void save(event)}>
      <label><span>Name</span><input value={form.name} maxLength={60} required placeholder="2026-27 Odd semester" onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} /></label>
      <label><span>Kind</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value as AcademicTermKind }))}>
        {data.options.kinds.map((kind) => <option key={kind} value={kind}>{academicTermKindLabels[kind]}</option>)}</select></label>
      <label><span>Starts on</span><input type="date" value={form.startsOn} required onChange={(event) => setForm((value) => ({ ...value, startsOn: event.target.value }))} /></label>
      <label><span>Ends on</span><input type="date" value={form.endsOn} required onChange={(event) => setForm((value) => ({ ...value, endsOn: event.target.value }))} /></label>
      <label><span>Applies to</span><select value={form.unitId} onChange={(event) => setForm((value) => ({ ...value, unitId: event.target.value }))}>
        <option value="">Whole college</option>
        {data.options.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.kind === 'PROGRAM' ? 'Programme' : 'Batch'}: {unit.name}</option>)}</select></label>
      <button type="submit">{editing ? 'Save changes' : 'Add to calendar'}</button>
      {editing ? <button type="button" className="secondary" onClick={() => { setEditing(null); setForm(emptyTerm); }}>Cancel</button> : null}
    </form> : null}
    {data?.canEdit && terms.length > 0 ? <label><span>Reason for archiving</span><select value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)}>
      {academicTermArchiveReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label> : null}
    {!data && !error ? <p role="status">Loading the academic calendar…</p> : null}
    {data && terms.length === 0 ? <p>No academic calendar has been set up yet.{data.canEdit ? ' Add your first term above.' : ' Your institution admin adds terms under Settings.'}</p> : null}
    {terms.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Academic calendar</caption>
      <thead><tr><th>Name</th><th>Kind</th><th>Dates</th><th>Applies to</th>{data?.canEdit ? <th>Actions</th> : null}</tr></thead>
      <tbody>{terms.map((term) => <tr key={term.id}>
        <th scope="row"><strong>{term.name}</strong>{term.current ? <span>Now</span> : null}</th>
        <td>{academicTermKindLabels[term.kind] ?? 'NA'}</td>
        <td>{formatDate(term.startsOn)} – {formatDate(term.endsOn)}</td>
        <td>{term.unit ? term.unit.name : 'Whole college'}</td>
        {data?.canEdit ? <td><div className="role-record-actions">
          <button type="button" className="secondary" onClick={() => edit(term)}>Edit</button>
          <button type="button" className="secondary" onClick={() => void archive(term)}>Archive</button>
        </div></td> : null}
      </tr>)}</tbody></table></div> : null}
    {data?.nextCursor ? <p className="hiring-meta">Showing the first 200 entries.</p> : null}
  </section>;
}

/** The academic calendar above the faculty member's meetings (faculty "Calendar"). */
export function FacultyAcademicCalendar({ authenticatedWorkspace }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement | null {
  const token = getProtectedAccessToken();
  if (!token || !isInstitutionStaffWorkspace(authenticatedWorkspace)) return null;
  return <AcademicCalendarPanel key={authenticatedWorkspace.organizationId} token={token} institutionId={authenticatedWorkspace.organizationId} />;
}

// --- Staff profile and notification preferences -----------------------------------------

function useStaffProfile(token: string, institutionId: string): readonly [StaffProfileDto | null, string, (next: StaffProfileDto) => void] {
  const [profile, setProfile] = useState<StaffProfileDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    getStaffProfile(token, institutionId, controller.signal)
      .then(({ staffProfile }) => { if (!controller.signal.aborted) setProfile(staffProfile); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Your profile could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId]);
  return [profile, error, setProfile] as const;
}

function StaffProfileSection({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [profile, error] = useStaffProfile(token, institutionId);
  if (error) return <p className="form-error role-wide" role="alert">{error}</p>;
  if (!profile) return <p className="role-wide" role="status">Loading your profile…</p>;
  return <section className="role-card role-wide" aria-label="Your profile">
    <h2>Your profile</h2>
    <div className="role-record-table-wrap"><table className="role-record-table"><tbody>
      <tr><th scope="row">Email</th><td>{profile.email}</td></tr>
      <tr><th scope="row">Institution</th><td>{profile.institutionName}</td></tr>
      {profile.roles.map((role, index) => <tr key={role.role + index}><th scope="row">{index === 0 ? 'Roles' : <span className="sr-only">Role</span>}</th>
        <td>{roleLabels[role.role] ?? 'Institution staff'}{role.department || role.batch ? ` · ${[role.department, role.batch].filter(Boolean).join(' · ')}` : ' · Whole institution'}</td></tr>)}
    </tbody></table></div>
    {profile.roles.some((role) => role.role === 'FACULTY_LECTURER') ? <>
      <h3>Teaching</h3>
      {profile.teachingAssignments.length ? <ul className="role-check-list">{profile.teachingAssignments.map((assignment, index) =>
        <li key={index}>{assignment.subject ?? 'NA'} · {assignment.unit} · {assignment.academicTerm}</li>)}</ul>
        : <p>No active teaching assignment.</p>}
    </> : null}
    <p className="hiring-meta">Your email and roles are managed by your institution's admins.</p>
  </section>;
}

function NotificationPreferencesSection({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [profile, loadError, setProfile] = useStaffProfile(token, institutionId);
  const [draft, setDraft] = useState<{ emailEnabled: boolean; quietStart: string; quietEnd: string; dailyCap: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!profile) return;
    const current: NotificationPreferencesDto = profile.notificationPreferences ?? profile.notificationDefaults;
    setDraft({ emailEnabled: current.emailEnabled, quietStart: minutesToTime(current.quietHoursStartMinute), quietEnd: minutesToTime(current.quietHoursEndMinute), dailyCap: String(current.dailyCap) });
  }, [profile]);
  if (loadError) return <p className="form-error role-wide" role="alert">{loadError}</p>;
  if (!profile || !draft) return <p className="role-wide" role="status">Loading your notification preferences…</p>;

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    const quietHoursStartMinute = timeToMinutes(draft.quietStart);
    const quietHoursEndMinute = timeToMinutes(draft.quietEnd);
    const dailyCap = Number(draft.dailyCap);
    if (quietHoursStartMinute === null || quietHoursEndMinute === null || !Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > 20) {
      setError('Quiet hours are times of day, and the daily limit is a whole number from 0 to 20.');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const { staffProfile } = await updateStaffNotificationPreferences(token, institutionId, { emailEnabled: draft.emailEnabled, quietHoursStartMinute, quietHoursEndMinute, dailyCap });
      setProfile(staffProfile);
      setNotice('Notification preferences saved.');
    } catch (cause) {
      setError(formatApiError(cause, 'Your notification preferences could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  return <form className="role-card role-wide role-management-form" aria-label="Notification preferences" onSubmit={(event) => void save(event)}>
    <h2>Notification preferences</h2>
    {!profile.staffRemindersLive ? <p>ONE does not send reminder emails to institution staff yet. What you save here applies as soon as it does.</p> : null}
    {!profile.notificationPreferences ? <p className="hiring-meta">You have not changed these yet, so ONE's defaults are shown.</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <label><input type="checkbox" checked={draft.emailEnabled} onChange={(event) => setDraft((value) => value && ({ ...value, emailEnabled: event.target.checked }))} /> <span>Email me reminders</span></label>
    <label><span>Quiet hours start</span><input type="time" value={draft.quietStart} required onChange={(event) => setDraft((value) => value && ({ ...value, quietStart: event.target.value }))} /></label>
    <label><span>Quiet hours end</span><input type="time" value={draft.quietEnd} required onChange={(event) => setDraft((value) => value && ({ ...value, quietEnd: event.target.value }))} /></label>
    <label><span>Most reminders a day</span><input type="number" min={0} max={20} step={1} value={draft.dailyCap} required onChange={(event) => setDraft((value) => value && ({ ...value, dailyCap: event.target.value }))} /></label>
    <button type="submit" disabled={busy}>Save preferences</button>
  </form>;
}

/** Faculty "Profile": the lecturer's own staff profile and teaching. */
export function StaffProfilePage({ authenticatedWorkspace }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  if (!token) return <RestrictedApiState title="Profile" message="Sign in to your institution workspace to see your profile." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Profile" />;
  return <StaffPilotWrap title="Profile" subtitle="Your staff account at your college and what you teach.">
    <StaffProfileSection key={authenticatedWorkspace.organizationId} token={token} institutionId={authenticatedWorkspace.organizationId} />
  </StaffPilotWrap>;
}

/** Faculty "Settings": the lecturer's own notification preferences. */
export function StaffSettingsPage({ authenticatedWorkspace }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  if (!token) return <RestrictedApiState title="Settings" message="Sign in to your institution workspace to change your settings." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Settings" />;
  return <StaffPilotWrap title="Settings" subtitle="How ONE may contact you.">
    <NotificationPreferencesSection key={authenticatedWorkspace.organizationId} token={token} institutionId={authenticatedWorkspace.organizationId} />
  </StaffPilotWrap>;
}
