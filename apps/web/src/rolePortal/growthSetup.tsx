/**
 * ONE · Role portal — Operations Settings: Growth set-up (GROWTH-02, design §16.2).
 *
 * A GROWTH_ADMIN holder imports the official LGD district list (a dry run first, then exactly what
 * was previewed), creates and retires sales regions, adds the states or districts each region
 * covers, and assigns growth people to regions as executive or manager. Territory decides whose
 * pipeline each growth person sees, so every change asks for a reason code from the server's list.
 *
 * A section of Settings, not a navigation item (O-24). It renders nothing for an operator without
 * GROWTH_ADMIN. The server decides everything; this screen only withholds controls it knows will
 * be refused (an area another region already holds is still offered, and the server says why).
 */
import { useEffect, useState } from 'react';
import {
  addGrowthRegionArea,
  ApiRequestError,
  assignGrowthTerritory,
  commitGrowthDistrictImport,
  createGrowthRegion,
  endGrowthTerritoryAssignment,
  getGrowthSetup,
  getProtectedAccessToken,
  listGrowthDistricts,
  previewGrowthDistrictImport,
  removeGrowthRegionArea,
  retireGrowthRegion,
  type GrowthDistrictImportReportDto,
  type GrowthSetupDto,
} from '../api.js';
import { V2Chip, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { formatApiError } from './shared.js';
import { formatDate } from '../dates.js';

const roleLabels: Readonly<Record<string, string>> = { EXECUTIVE: 'Executive', MANAGER: 'Manager', GROWTH_EXECUTIVE: 'Growth executive', GROWTH_MANAGER: 'Regional manager' };
const statusLabels: Readonly<Record<string, string>> = { NEW: 'New', UNCHANGED: 'Unchanged', RENAMED: 'Renamed', ERROR: 'Error' };

function reasonLabel(code: string): string {
  return code.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
}

function ReasonSelect({ label, reasons, value, onChange }: {
  readonly label: string; readonly reasons: readonly string[]; readonly value: string; readonly onChange: (value: string) => void;
}): React.ReactElement {
  return <label>{label}<select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Reason…</option>
    {reasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
  </select></label>;
}

export function OperationsGrowthSetupPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [setup, setSetup] = useState<GrowthSetupDto | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [regionName, setRegionName] = useState('');
  const [regionReason, setRegionReason] = useState('');

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    getGrowthSetup(token, controller.signal)
      .then((result) => { setSetup(result); setError(''); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbidden(true);
        else setError(formatApiError(cause, 'Unable to load growth set-up.'));
      });
    return () => controller.abort();
  }, [token, reload]);

  // Not a GROWTH_ADMIN holder: this section does not exist for them.
  if (!token || forbidden) return null;
  if (!setup && !error) return null;

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      setNotice(done);
      setError('');
      setReload((value) => value + 1);
      return true;
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be saved.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const live = (setup?.regions ?? []).filter((region) => !region.retiredAt);
  const retired = (setup?.regions ?? []).filter((region) => region.retiredAt);
  const districtTotal = (setup?.states ?? []).reduce((total, state) => total + state.districtCount, 0);
  const reasons = setup?.vocabulary.reasons;

  return <section className="role-module role-module--dense" aria-labelledby="growth-setup-heading">
    <div className="role-page-heading"><div><span className="eyebrow">Settings</span><h1 id="growth-setup-heading">Growth set-up</h1>
      <p>Regions, the states and districts each covers, and who works them. Territory decides which unowned leads a growth person sees, so every change asks for a reason and is kept in the history.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide" role="region" aria-label="Growth set-up summary">
      <V2Stat icon="🗺️" tone="teal" value={setup ? live.length : 'NA'} label="Live regions" />
      <V2Stat icon="📍" tone="blue" value={setup ? live.reduce((total, region) => total + region.areas.length, 0) : 'NA'} label="Areas covered" />
      <V2Stat icon="👥" tone="amber" value={setup ? new Set(live.flatMap((region) => region.assignments.map((assignment) => assignment.membershipId))).size : 'NA'} label="People assigned" />
      <V2Stat icon="🏙️" tone="purple" value={setup ? districtTotal : 'NA'} label="Districts imported" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    {setup ? <DistrictImport setup={setup} token={token} busy={busy} run={run} /> : null}

    <section className="role-card role-wide"><h2>Regions</h2>
      <p>A region is a named sales area. Add whole states or single districts to it; a whole state and a district of it cannot sit in different regions.</p>
      <div className="role-actions">
        <label>Region name<input value={regionName} maxLength={60} onChange={(event) => setRegionName(event.target.value)} placeholder="For example South-1" /></label>
        <ReasonSelect label="Reason for the new region" reasons={reasons?.createRegion ?? []} value={regionReason} onChange={setRegionReason} />
        <button type="button" className="pilot-btn" disabled={!regionName.trim() || !regionReason || busy} onClick={() => void run(async () => {
          await createGrowthRegion(token, { name: regionName.trim(), reasonCode: regionReason });
          setRegionName(''); setRegionReason('');
        }, 'Region created.')}>Create region</button>
      </div>
      {setup && !live.length ? <V2EmptyState icon="🗺️" title="No regions yet" note="Create a region, then add the states or districts it covers and assign people to it." /> : null}
      {setup?.truncated ? <p>Showing the first 200 regions.</p> : null}
      {live.map((region) => <RegionCard key={region.id} region={region} setup={setup!} token={token} busy={busy} run={run} />)}
      {retired.length ? <details><summary>Retired regions ({retired.length})</summary><ul>
        {retired.map((region) => <li key={region.id}>{region.name} — retired {region.retiredAt ? formatDate(region.retiredAt) : 'NA'} ({reasonLabel(region.retiredReasonCode ?? 'NA')})</li>)}
      </ul></details> : null}
    </section>
  </section>;
}

/** jsdom and older browsers lack File.text(); FileReader works everywhere. */
async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsText(file);
  });
}

type Run = (action: () => Promise<unknown>, done: string) => Promise<boolean>;

function DistrictImport({ setup, token, busy, run }: { readonly setup: GrowthSetupDto; readonly token: string; readonly busy: boolean; readonly run: Run }): React.ReactElement {
  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<GrowthDistrictImportReportDto | null>(null);
  const [reason, setReason] = useState('');
  const last = setup.lastImport;

  return <section className="role-card role-wide" aria-label="District import"><h2>Districts (LGD import)</h2>
    <p>Districts come from the official Local Government Directory list (lgdirectory.gov.in), downloaded as CSV. Preview first: nothing is written until you commit exactly the file you previewed. Districts are never deleted; a changed name is recorded.</p>
    <p>{last ? <>Last import: <strong>{last.filename}</strong> by {last.importedBy}{last.importedAt ? ` on ${formatDate(last.importedAt)}` : ''} — {last.created} new, {last.renamed} renamed, {last.unchanged} unchanged.</>
      : 'No district list has been imported yet. Regions can still cover whole states.'}</p>
    <div className="role-actions">
      <label>LGD district file (CSV)<input type="file" accept=".csv,text/csv" aria-label="LGD district file" onChange={(event) => {
        const file = event.target.files?.[0];
        setPreview(null);
        if (!file) return;
        setFilename(file.name);
        void readFileText(file).then(setContent).catch(() => setContent(''));
      }} /></label>
      <button type="button" className="pilot-btn" disabled={!content || busy} onClick={() => void run(async () => {
        const result = await previewGrowthDistrictImport(token, { filename: filename || 'districts.csv', content });
        setPreview(result.preview);
      }, 'Preview ready. Nothing has been written.')}>Preview import</button>
    </div>
    {preview ? <div aria-label="Import preview">
      <p>{preview.counts.new} new · {preview.counts.renamed} renamed · {preview.counts.unchanged} unchanged · {preview.counts.errors} with errors</p>
      {preview.fileProblems.length ? <p className="form-error">File problems: {preview.fileProblems.join(', ')}</p> : null}
      {preview.rows.some((row) => row.status !== 'UNCHANGED') ? <div className="role-record-table-wrap"><table className="role-record-table"><thead><tr><th>Line</th><th>Code</th><th>District</th><th>State</th><th>Result</th></tr></thead><tbody>
        {preview.rows.filter((row) => row.status !== 'UNCHANGED').slice(0, 50).map((row) => <tr key={row.line}>
          <td>{row.line}</td><td>{row.districtCode ?? 'NA'}</td><td>{row.districtName ?? 'NA'}{row.previousName ? ` (was ${row.previousName})` : ''}</td>
          <td>{row.stateCode ?? 'NA'}</td><td>{statusLabels[row.status] ?? row.status}{row.issues.length ? `: ${row.issues.map(reasonLabel).join(', ')}` : ''}</td>
        </tr>)}
      </tbody></table></div> : null}
      {preview.committable ? <div className="role-actions">
        <ReasonSelect label="Reason for the import" reasons={setup.vocabulary.reasons.importDistricts} value={reason} onChange={setReason} />
        <button type="button" className="pilot-btn" disabled={!reason || busy} onClick={() => void run(async () => {
          await commitGrowthDistrictImport(token, { filename: filename || 'districts.csv', content, previewDigest: preview.digest, reasonCode: reason });
          setPreview(null); setContent(''); setReason('');
        }, 'Districts imported.')}>Commit import</button>
      </div> : <p>Fix the file and preview it again: an import with any error is refused whole.</p>}
    </div> : null}
  </section>;
}

function RegionCard({ region, setup, token, busy, run }: {
  readonly region: GrowthSetupDto['regions'][number]; readonly setup: GrowthSetupDto; readonly token: string; readonly busy: boolean; readonly run: Run;
}): React.ReactElement {
  const reasons = setup.vocabulary.reasons;
  const [stateCode, setStateCode] = useState('');
  const [districts, setDistricts] = useState<readonly { readonly code: number; readonly name: string; readonly region: { readonly name: string } | null }[]>([]);
  const [district, setDistrict] = useState('');
  const [areaReason, setAreaReason] = useState('');
  const [removeReason, setRemoveReason] = useState('');
  const [person, setPerson] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [endReason, setEndReason] = useState('');
  const [retireReason, setRetireReason] = useState('');

  useEffect(() => {
    setDistrict('');
    setDistricts([]);
    if (!stateCode) return undefined;
    const controller = new AbortController();
    listGrowthDistricts(token, stateCode, controller.signal).then((result) => setDistricts(result.districts)).catch(() => undefined);
    return () => controller.abort();
  }, [stateCode, token]);

  const chosen = setup.people.find((entry) => entry.membershipId === person);
  const assignedIds = new Set(region.assignments.map((assignment) => assignment.membershipId));
  const inUse = region.areas.length > 0 || region.assignments.length > 0;

  return <article className="role-card" aria-label={`Region ${region.name}`}>
    <h3>{region.name}</h3>
    <p><V2Chip tone="teal">{region.areas.length} area{region.areas.length === 1 ? '' : 's'}</V2Chip> <V2Chip tone="blue">{region.assignments.length} assigned</V2Chip></p>

    <h4>Areas</h4>
    {region.areas.length ? <ul>{region.areas.map((area) => <li key={area.id}>
      {area.districtName ? `${area.districtName}, ${area.stateName}` : `${area.stateName} (whole state)`}
      {' '}<button type="button" className="pilot-btn" disabled={!removeReason || busy}
        onClick={() => void run(() => removeGrowthRegionArea(token, region.id, area.id, { reasonCode: removeReason }), 'Area removed.')}>Remove</button>
    </li>)}</ul> : <p>No areas yet.</p>}
    {region.areas.length ? <ReasonSelect label={`Reason for removing an area of ${region.name}`} reasons={reasons.removeArea} value={removeReason} onChange={setRemoveReason} /> : null}
    <div className="role-actions">
      <label>State<select aria-label={`State to add to ${region.name}`} value={stateCode} onChange={(event) => setStateCode(event.target.value)}>
        <option value="">Choose…</option>
        {setup.states.map((state) => <option key={state.code} value={state.code}>{state.name}{state.kind === 'UNION_TERRITORY' ? ' (UT)' : ''}</option>)}
      </select></label>
      <label>District<select aria-label={`District to add to ${region.name}`} value={district} disabled={!stateCode} onChange={(event) => setDistrict(event.target.value)}>
        <option value="">Whole state</option>
        {districts.map((entry) => <option key={entry.code} value={String(entry.code)}>{entry.name}{entry.region ? ` — in ${entry.region.name}` : ''}</option>)}
      </select></label>
      <ReasonSelect label={`Reason for adding an area to ${region.name}`} reasons={reasons.addArea} value={areaReason} onChange={setAreaReason} />
      <button type="button" className="pilot-btn" disabled={!stateCode || !areaReason || busy} onClick={() => void run(async () => {
        await addGrowthRegionArea(token, region.id, { stateCode, districtCode: district ? Number(district) : null, reasonCode: areaReason });
        setStateCode(''); setAreaReason('');
      }, 'Area added.')}>Add area</button>
    </div>

    <h4>People</h4>
    {region.assignments.length ? <ul>{region.assignments.map((assignment) => <li key={assignment.id}>
      {assignment.email} · {roleLabels[assignment.role] ?? assignment.role}{assignment.membershipState !== 'ACTIVE' ? ` · ${reasonLabel(assignment.membershipState)}` : ''}
      {assignment.startsAt ? ` · since ${formatDate(assignment.startsAt)}` : ''}
      {' '}<button type="button" className="pilot-btn" disabled={!endReason || busy}
        onClick={() => void run(() => endGrowthTerritoryAssignment(token, region.id, assignment.id, { reasonCode: endReason }), 'Assignment ended.')}>End</button>
    </li>)}</ul> : <p>Nobody is assigned yet.</p>}
    {region.assignments.length ? <ReasonSelect label={`Reason for ending an assignment in ${region.name}`} reasons={reasons.endAssignment} value={endReason} onChange={setEndReason} /> : null}
    <div className="role-actions">
      <label>Growth person<select aria-label={`Person to assign to ${region.name}`} value={person} onChange={(event) => setPerson(event.target.value)}>
        <option value="">Choose…</option>
        {setup.people.filter((entry) => !assignedIds.has(entry.membershipId)).map((entry) => <option key={entry.membershipId} value={entry.membershipId}>{entry.email} ({roleLabels[entry.role] ?? entry.role})</option>)}
      </select></label>
      <ReasonSelect label={`Reason for assigning to ${region.name}`} reasons={reasons.startAssignment} value={assignReason} onChange={setAssignReason} />
      <button type="button" className="pilot-btn" disabled={!chosen || !assignReason || busy} onClick={() => void run(async () => {
        await assignGrowthTerritory(token, region.id, { membershipId: chosen!.membershipId, role: chosen!.role === 'GROWTH_MANAGER' ? 'MANAGER' : 'EXECUTIVE', reasonCode: assignReason });
        setPerson(''); setAssignReason('');
      }, 'Person assigned.')}>Assign{chosen ? ` as ${chosen.role === 'GROWTH_MANAGER' ? 'manager' : 'executive'}` : ''}</button>
    </div>

    <div className="role-actions">
      <ReasonSelect label={`Reason for retiring ${region.name}`} reasons={reasons.retireRegion} value={retireReason} onChange={setRetireReason} />
      <button type="button" className="pilot-btn" disabled={inUse || !retireReason || busy}
        onClick={() => void run(() => retireGrowthRegion(token, region.id, { reasonCode: retireReason }), 'Region retired.')}>Retire region</button>
      {inUse ? <small>Remove its areas and end its assignments before retiring it.</small> : null}
    </div>
  </article>;
}
