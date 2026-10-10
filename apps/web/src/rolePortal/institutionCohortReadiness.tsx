/**
 * ONE · Role portal — Institution — Cohort readiness by career role and preparation sprints (INST-17).
 *
 * Why it exists: the placement office's journey (UAT J11) — choose the role an employer is hiring for, see where
 * the cohort stands on each essential requirement, and run a time-boxed preparation sprint for the students with
 * gaps. It sits on existing screens only (admin Career Readiness, placement officer Readiness, department head
 * Readiness — no navigation change, HG-3).
 *
 * Rules on this screen: readiness is shown as bands of a requirement, never a number; every count of people comes
 * from the server already suppressed ("<5"); no student is named; the scope comes from the server and nothing is
 * filtered here for security; missing data reads NA. A sprint is a set of work students see on Learning — it never
 * changes their results or readiness.
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  createPreparationSprint,
  endPreparationSprint,
  getCohortReadiness,
  getCohortRoles,
  getProtectedAccessToken,
  listInstitutionUnits,
  listPreparationSprints,
  suppressedCountLabel,
} from '../api.js';
import type {
  CohortReadinessDto,
  CohortRequirementDto,
  CohortRolesDto,
  CountCellDto,
  InstitutionUnitDto,
  PreparationSprintDto,
  PreparationSprintsDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { NaValue } from '../naState.js';
import { SMALL_COUNT_TEXT } from '../momentum/smallCountRule.js';
import { formatApiError } from './shared.js';
import { supportCodeSuffix } from '../supportCode.js';
import { formatDate } from '../dates.js';

export const REQUIREMENT_CELL_LABELS: Readonly<Record<string, string>> = {
  MET: 'Met', PARTIAL: 'Partly there', MISSING: 'Not yet', NOT_ENOUGH_EVIDENCE: 'Too little evidence', NO_EVIDENCE: 'No evidence yet',
};
export const SPRINT_CELL_LABELS: Readonly<Record<string, string>> = {
  MET: 'Now meet it', NEW_EVIDENCE: 'New evidence, not yet met', NO_NEW_EVIDENCE: 'Nothing new yet',
};
export const SPRINT_REASON_LABELS: Readonly<Record<string, string>> = {
  CAMPUS_DRIVE_PREPARATION: 'Preparing for a campus drive', ESSENTIAL_GAP: 'A gap in an essential requirement', PLACEMENT_SEASON: 'Placement season preparation',
};
const END_LABELS: Readonly<Record<string, string>> = { NO_LONGER_NEEDED: 'No longer needed', SET_IN_ERROR: 'Started in error', REPLACED: 'Replaced by another sprint' };
const STATE_LABELS: Readonly<Record<string, string>> = { RUNNING: 'Running', ENDED: 'Ended', CANCELLED: 'Ended early' };
const KIND_LABELS: Readonly<Record<string, string>> = { PRACTICE: 'Practice set', LESSON: 'Lesson' };

const ERROR_TEXT: Readonly<Record<string, string>> = {
  SCOPE_REQUIRED: 'Your role needs a department or unit scope before you can run a sprint. Ask your institution administrator.',
  NO_STUDENTS_WITH_GAPS: 'No current student in your scope has a gap in this requirement, so there is no one to run a sprint for.',
  SPRINT_TOO_LARGE: 'A sprint reaches at most 500 students. Choose a department, batch or section.',
  NOT_AN_ESSENTIAL_REQUIREMENT: 'Choose one of this role’s essential requirements.',
  CONTENT_NOT_PUBLISHED: 'That content is no longer published. Reload and choose again.',
  DRIVE_ROLE_MISMATCH: 'That campus drive is no longer live at your college for this role.',
  REPORT_PERIOD_INVALID: 'Choose a whole calendar month that has ended.',
  SPRINT_NOT_RUNNING: 'This sprint has already ended.',
  NOT_SPRINT_OWNER: 'Only the person who started this sprint, or an administrator, can end it.',
  INVALID_REASON_CODE: 'Choose one of the listed reasons.',
};

function sprintError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.code && ERROR_TEXT[error.code]) return `${ERROR_TEXT[error.code]}${supportCodeSuffix(error.correlationId)}`;
    if (error.status === 403) return `You do not have access to cohort readiness.${supportCodeSuffix(error.correlationId)}`;
  }
  return formatApiError(error, fallback);
}

const day = (value: string): string => formatDate(value);
const cellLabel = (cells: readonly CountCellDto[], key: string): string => {
  const cell = cells.find((entry) => entry.key === key);
  return cell ? suppressedCountLabel(cell) : 'NA';
};

function isRoles(value: unknown): value is CohortRolesDto {
  const body = value as Partial<CohortRolesDto> | null;
  return Boolean(body && Array.isArray(body.roles) && Array.isArray(body.drives));
}
function isView(value: unknown): value is CohortReadinessDto {
  const body = value as Partial<CohortReadinessDto> | null;
  return Boolean(body && body.role && body.period && Array.isArray(body.requirements) && body.cohort);
}
function isSprints(value: unknown): value is PreparationSprintsDto {
  const body = value as Partial<PreparationSprintsDto> | null;
  return Boolean(body && Array.isArray(body.sprints) && Array.isArray(body.cancelReasonCodes));
}

/** `role:<id>` for a catalogue role, `drive:<driveId>` for the role behind a campus drive. */
type Choice = { readonly roleId: string; readonly driveId: string | null } | null;

export function CohortReadinessByRoleSection({ institutionId }: { readonly institutionId: string }): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [roles, setRoles] = useState<CohortRolesDto | null>(null);
  const [choice, setChoice] = useState<Choice>(null);
  const [month, setMonth] = useState('');
  const [view, setView] = useState<CohortReadinessDto | null>(null);
  const [sprints, setSprints] = useState<PreparationSprintsDto | null>(null);
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [sprintFor, setSprintFor] = useState<CohortRequirementDto | null>(null);
  const [error, setError] = useState('');
  const [viewError, setViewError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    getCohortRoles(token, institutionId, controller.signal)
      .then((body) => { if (isRoles(body)) setRoles(body); else setError('Unable to load career roles.'); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(sprintError(cause, 'Unable to load career roles.')); });
    listInstitutionUnits(token, institutionId, controller.signal)
      .then((body) => setUnits(Array.isArray(body?.units) ? body.units : []))
      .catch(() => { if (!controller.signal.aborted) setUnits([]); });
    return () => controller.abort();
  }, [token, institutionId]);

  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    listPreparationSprints(token, institutionId, controller.signal)
      .then((body) => { if (isSprints(body)) setSprints(body); else setError('Unable to load preparation sprints.'); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(sprintError(cause, 'Unable to load preparation sprints.')); });
    return () => controller.abort();
  }, [token, institutionId, reload]);

  useEffect(() => {
    if (!token || !institutionId || !choice) return;
    const controller = new AbortController();
    setView(null); setViewError(''); setSprintFor(null);
    getCohortReadiness(token, institutionId, choice.roleId, month || null, controller.signal)
      .then((body) => { if (isView(body)) setView(body); else setViewError('Unable to load cohort readiness for this role.'); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setViewError(sprintError(cause, 'Unable to load cohort readiness for this role.')); });
    return () => controller.abort();
  }, [token, institutionId, choice, month]);

  if (!token || !institutionId) return null;

  function choose(value: string): void {
    setNotice('');
    if (value.startsWith('drive:')) {
      const drive = (roles?.drives ?? []).find((entry) => entry.driveId === value.slice(6));
      setChoice(drive ? { roleId: drive.careerRoleId, driveId: drive.driveId } : null);
    } else if (value.startsWith('role:')) setChoice({ roleId: value.slice(5), driveId: null });
    else setChoice(null);
  }

  const drive = choice?.driveId ? (roles?.drives ?? []).find((entry) => entry.driveId === choice.driveId) ?? null : null;
  const running = sprints ? sprints.sprints.filter((sprint) => sprint.state === 'RUNNING').length : null;

  return <section className="pilot-card" aria-label="Cohort readiness by career role">
    <div className="pilot-card-head"><h2>Cohort readiness by career role</h2><small style={{ color: 'var(--p-muted)' }}>{view ? view.period.month : 'Last month'}</small></div>
    <p>Choose the role an employer is hiring for. For each essential requirement you see how your students stood at the end of a month —
      as bands, never scores — and you can run a preparation sprint for the students with gaps. No student is named, and any group
      smaller than five reads &lt;5.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="v2-row v2-cols-4 career-stat-strip">
      <V2Stat icon="🎯" tone="blue" value={view ? view.role.title : 'NA'} label="Career role" />
      <V2Stat icon="👥" tone="indigo" value={view ? (view.cohort.suppressed ? SMALL_COUNT_TEXT : suppressedCountLabel(view.cohort.total)) : 'NA'} label="Students in the month" />
      <V2Stat icon="🧩" tone="purple" value={view ? view.requirementCounts.essential : 'NA'} label="Essential requirements" />
      <V2Stat icon="🏃" tone="green" value={running ?? 'NA'} label="Sprints running" />
    </div>
    <form className="role-management-form" aria-label="Choose a role" onSubmit={(event) => event.preventDefault()}>
      <label><span>Role</span><select aria-label="Career role" defaultValue="" onChange={(event) => choose(event.target.value)}>
        <option value="">{roles ? 'Choose a role' : 'Loading roles…'}</option>
        {roles && roles.drives.length ? <optgroup label="From your campus drives">
          {roles.drives.map((entry) => <option key={entry.driveId} value={`drive:${entry.driveId}`}>{`${entry.employerName} — ${entry.jobTitle} (${entry.roleTitle})`}</option>)}
        </optgroup> : null}
        {roles ? <optgroup label="Career catalogue">
          {roles.roles.map((role) => <option key={role.id} value={`role:${role.id}`}>{`${role.catalogueCode ? `${role.catalogueCode} · ` : ''}${role.title}${role.essentialRequirements ? '' : ' (no requirements published)'}`}</option>)}
        </optgroup> : null}
      </select></label>
      <label><span>Month (ended)</span><input type="month" aria-label="Month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
    </form>
    {drive ? <p>{`Campus drive: ${drive.employerName} — ${drive.jobTitle}. A sprint you start here is recorded against this drive.`}</p> : null}
    {viewError ? <p className="form-error" role="alert">{viewError}</p> : null}
    {choice && !view && !viewError ? <p role="status">Loading cohort readiness…</p> : null}
    {!choice ? <V2EmptyState icon="🎯" title="Choose a role" note="Pick a career role, or the role behind one of your college's campus drives, to see where your students stand." /> : null}
    {view ? <RequirementTable view={view} onSprint={(requirement) => { setSprintFor(requirement); setNotice(''); }} /> : null}
    {view && sprintFor ? <SprintForm key={sprintFor.topicId} view={view} requirement={sprintFor} driveId={choice?.driveId ?? null} units={units}
      token={token} institutionId={institutionId} onCancel={() => setSprintFor(null)}
      onDone={(message) => { setSprintFor(null); setNotice(message); setReload((value) => value + 1); }} /> : null}
    <SprintList sprints={sprints} token={token} institutionId={institutionId}
      onChanged={(message) => { setNotice(message); setReload((value) => value + 1); }} />
  </section>;
}

function RequirementTable({ view, onSprint }: { readonly view: CohortReadinessDto; readonly onSprint: (requirement: CohortRequirementDto) => void }): React.ReactElement {
  const scopeText = view.scope.kind === 'UNITS' && view.scope.units.length ? ` Your students: ${view.scope.units.map((unit) => unit.name).join(', ')}.` : '';
  if (view.requirements.length === 0) {
    return <V2EmptyState icon="🧩" title="No essential requirements published"
      note={`${view.role.title} has no essential requirement in ONE's career catalogue yet, so there is nothing to measure: NA.`} />;
  }
  return <>
    <p>{`As at the end of ${view.period.month}.${scopeText}${view.requirementCounts.other ? ` ${view.requirementCounts.other} further requirement${view.requirementCounts.other === 1 ? ' is' : 's are'} not essential and not shown.` : ''}`}</p>
    {view.cohort.suppressed ? <p>Fewer than five students are in this cohort, so every figure is withheld.</p> : null}
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Essential requirements</caption>
      <thead><tr><th scope="col">Essential requirement</th>
        {Object.values(REQUIREMENT_CELL_LABELS).map((label) => <th key={label} scope="col">{label}</th>)}
        <th scope="col">Gaps</th><th scope="col">Unknowns</th><th scope="col">Sprint</th></tr></thead>
      <tbody>{view.requirements.map((requirement) => <tr key={requirement.topicId}>
        <th scope="row">{requirement.skillName}</th>
        {Object.keys(REQUIREMENT_CELL_LABELS).map((key) => <td key={key}><NaValue value={requirement.cells.length ? cellLabel(requirement.cells, key) : SMALL_COUNT_TEXT} /></td>)}
        <td><NaValue value={suppressedCountLabel(requirement.gaps)} /></td>
        <td><NaValue value={suppressedCountLabel(requirement.unknowns)} /></td>
        <td>{view.canRunSprints && requirement.resources.length
          ? <button type="button" className="pilot-link" onClick={() => onSprint(requirement)}>Run a sprint</button>
          : requirement.resources.length ? 'NA' : 'No published content'}</td>
      </tr>)}</tbody></table></div>
    {!view.canRunSprints ? <p>Your role needs a department or unit scope before you can run a sprint.</p> : null}
  </>;
}

function SprintForm({ view, requirement, driveId, units, token, institutionId, onCancel, onDone }: {
  readonly view: CohortReadinessDto; readonly requirement: CohortRequirementDto; readonly driveId: string | null;
  readonly units: readonly InstitutionUnitDto[]; readonly token: string; readonly institutionId: string;
  readonly onCancel: () => void; readonly onDone: (message: string) => void;
}): React.ReactElement {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const resource = requirement.resources[Number(form.get('resource') ?? 0)];
    const durationDays = Number(form.get('durationDays') ?? 14);
    const reasonCode = String(form.get('reasonCode') ?? '');
    const note = String(form.get('note') ?? '').trim();
    const unitId = String(form.get('unitId') ?? '');
    if (!resource || !reasonCode) { setError('Choose what to practise and a reason.'); return; }
    setBusy(true); setError('');
    try {
      const created = await createPreparationSprint(token, institutionId, {
        careerRoleId: view.role.id, topicId: requirement.topicId,
        resource: { kind: resource.kind, skillId: resource.skillId, lessonVersionId: resource.lessonVersionId },
        durationDays, includeUnknown: form.get('includeUnknown') === 'on', reasonCode,
        ...(note ? { note } : {}), ...(unitId ? { unitId } : {}), ...(driveId ? { campusDriveId: driveId } : {}),
      });
      onDone(`Sprint started for ${suppressedCountLabel(created.sprint.reached)} students until ${day(created.sprint.endsAt)}. They have been told on Learning.`);
    } catch (cause) {
      setError(sprintError(cause, 'The sprint could not be started.'));
    } finally {
      setBusy(false);
    }
  }

  return <form className="role-management-form" aria-label="Run a preparation sprint" onSubmit={(event) => { void submit(event); }}>
    <h3>{`Run a preparation sprint: ${requirement.skillName}`}</h3>
    <p>The sprint goes to the students in your scope who are partly there or not yet there on this requirement. It appears on their
      Learning page as the next thing to do, until the sprint ends. You will see counts only, never names.</p>
    <label><span>What to practise</span><select name="resource" defaultValue="0">
      {requirement.resources.map((resource, index) => <option key={`${resource.kind}:${resource.lessonVersionId ?? resource.skillId}`} value={index}>{`${resource.title} (${KIND_LABELS[resource.kind] ?? 'Content'})`}</option>)}
    </select></label>
    <label><span>Length (days)</span><input name="durationDays" type="number" min={view.sprintDays.min} max={view.sprintDays.max} defaultValue={14} /></label>
    <label><span>Who</span><select name="unitId" defaultValue="">
      <option value="">Everyone in your scope</option>
      {units.filter((unit) => unit.kind !== 'INSTITUTION').map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
    </select></label>
    <label><input name="includeUnknown" type="checkbox" /> Also include students with no evidence or too little evidence</label>
    <label><span>Reason</span><select name="reasonCode" defaultValue={driveId ? 'CAMPUS_DRIVE_PREPARATION' : ''}>
      <option value="">Choose a reason</option>
      {view.sprintReasonCodes.map((code) => <option key={code} value={code}>{SPRINT_REASON_LABELS[code] ?? code}</option>)}
    </select></label>
    <label><span>Note to the students (optional)</span><textarea name="note" maxLength={500} /></label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="hiring-actions">
      <button type="submit" disabled={busy}>Start the sprint</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

function SprintList({ sprints, token, institutionId, onChanged }: {
  readonly sprints: PreparationSprintsDto | null; readonly token: string; readonly institutionId: string; readonly onChanged: (message: string) => void;
}): React.ReactElement {
  const [error, setError] = useState('');
  async function end(sprint: PreparationSprintDto, reasonCode: string): Promise<void> {
    setError('');
    try {
      await endPreparationSprint(token, institutionId, sprint.id, reasonCode);
      onChanged('Sprint ended. Its work has been withdrawn from the students’ Learning pages.');
    } catch (cause) {
      setError(sprintError(cause, 'The sprint could not be ended.'));
    }
  }
  return <>
    <h3>Preparation sprints</h3>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!sprints ? <p role="status">Loading preparation sprints…</p> : sprints.sprints.length === 0
      ? <V2EmptyState icon="🏃" title="No sprints yet" note="Sprints you and your colleagues start appear here with their progress." />
      : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Preparation sprints</caption>
        <thead><tr><th scope="col">Sprint</th><th scope="col">When</th><th scope="col">Reached</th>
          {Object.values(SPRINT_CELL_LABELS).map((label) => <th key={label} scope="col">{label}</th>)}
          <th scope="col">Work done</th><th scope="col">Actions</th></tr></thead>
        <tbody>{sprints.sprints.map((sprint) => <tr key={sprint.id}>
          <th scope="row">{`${sprint.role.title} · ${sprint.skillName}`}
            <span>{`${sprint.resource.title} · ${SPRINT_REASON_LABELS[sprint.reasonCode] ?? 'NA'}${sprint.drive ? ` · ${sprint.drive.employerName}` : ''}${sprint.unitName ? ` · ${sprint.unitName}` : ''}`}</span></th>
          <td>{`${day(sprint.startsAt)} – ${day(sprint.endsAt)} · ${STATE_LABELS[sprint.state] ?? 'NA'}`}</td>
          <td><NaValue value={sprint.progress.available ? suppressedCountLabel(sprint.progress.reached) : 'NA'} /></td>
          {Object.keys(SPRINT_CELL_LABELS).map((key) => <td key={key}><NaValue value={!sprint.progress.available || !sprint.progress.requirementLive ? 'NA'
            : sprint.progress.cells.length ? cellLabel(sprint.progress.cells, key) : SMALL_COUNT_TEXT} /></td>)}
          <td><NaValue value={sprint.progress.available ? suppressedCountLabel(sprint.progress.workDone) : 'NA'} /></td>
          <td>{sprint.canEnd ? <select aria-label={`End sprint ${sprint.role.title} ${sprint.skillName}`} defaultValue="" onChange={(event) => { if (event.target.value) void end(sprint, event.target.value); }}>
            <option value="">End early…</option>
            {sprints.cancelReasonCodes.map((code) => <option key={code} value={code}>{END_LABELS[code] ?? code}</option>)}
          </select> : '—'}</td>
        </tr>)}</tbody></table></div>}
    {(sprints?.sprints ?? []).some((sprint) => !sprint.progress.available) ? <p>A sprint’s first figures appear the day after it starts. Progress is counted up to the start of each day, from the students’ own evidence.</p> : null}
  </>;
}
