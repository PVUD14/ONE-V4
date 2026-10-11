/**
 * ONE · Employer portal — a job's eligibility, skills and selection stages (EMP-06).
 *
 * Part of the existing Opportunity Detail screen (no navigation change). It shows what the
 * current version asks for, and edits it the only way a job changes: by saving a new version
 * (EMP-05's versioning path), with the current terms sent back unchanged. Earlier versions, and
 * the rules applicants applied under, stay as they were.
 *
 * The server decides what is allowed: the fixed rule types, which rules may block (custom and
 * work-authorisation rules never do), refusing a rule that names a protected attribute, the
 * stage order, which skills are in the ONE catalogue, and whether a live job's eligibility
 * change needs a reason. This screen offers the same choices and reports the server's answer.
 */
import { useEffect, useState } from 'react';
import {
  createOpportunityVersion,
  listScorecardTemplates,
  searchSkillCatalogue,
  type EligibilityRuleDto,
  type OpportunityRequirementsDto,
  type OpportunityVersionTermsDto,
  type SkillCatalogueDto,
} from '../api/hiring.js';
import { describeEligibilityRule, stageKindLabels } from '../hiringEligibility.js';
import { formatApiError } from './shared.js';

type RuleType = 'MIN_CGPA' | 'MAX_BACKLOGS' | 'GRADUATION_YEAR' | 'DEPARTMENT' | 'PROGRAM' | 'INSTITUTION' | 'WORK_AUTHORIZATION' | 'CUSTOM';

/** The rule types the editor offers, with the comparators each accepts (mirrors packages/hiring). */
const editableRuleTypes: readonly { readonly type: RuleType; readonly label: string; readonly comparators: readonly string[]; readonly numeric: boolean }[] = [
  { type: 'MIN_CGPA', label: 'Minimum CGPA (10-point scale)', comparators: ['GTE'], numeric: true },
  { type: 'MAX_BACKLOGS', label: 'Maximum active backlogs', comparators: ['LTE'], numeric: true },
  { type: 'GRADUATION_YEAR', label: 'Graduation year', comparators: ['IN', 'NOT_IN', 'EQ', 'GTE', 'LTE'], numeric: false },
  { type: 'DEPARTMENT', label: 'Department', comparators: ['IN', 'NOT_IN'], numeric: false },
  { type: 'PROGRAM', label: 'Programme', comparators: ['IN', 'NOT_IN'], numeric: false },
  { type: 'WORK_AUTHORIZATION', label: 'Work authorisation (shown, never blocks)', comparators: ['EQ'], numeric: false },
  { type: 'CUSTOM', label: 'Other requirement (shown, never blocks)', comparators: ['EQ'], numeric: false },
];
const comparatorLabels: Readonly<Record<string, string>> = { GTE: 'at least / from', LTE: 'at most / up to', EQ: 'exactly', IN: 'one of', NOT_IN: 'not one of' };
const neverBlocks = (type: string) => type === 'CUSTOM' || type === 'WORK_AUTHORIZATION';
const numericComparator = (type: string, comparator: string) => type === 'MIN_CGPA' || type === 'MAX_BACKLOGS' || (type === 'GRADUATION_YEAR' && !['IN', 'NOT_IN'].includes(comparator));

const reasonLabels: Readonly<Record<string, string>> = {
  DETAILS_CORRECTED: 'Correcting a mistake', TERMS_UPDATED: 'The terms changed', ELIGIBILITY_CORRECTED: 'Eligibility was stated wrongly',
  ELIGIBILITY_RELAXED: 'Eligibility relaxed', ELIGIBILITY_TIGHTENED: 'Eligibility tightened', PLACEMENT_OFFICE_REQUEST: 'The placement office asked',
  SKILLS_UPDATED: 'Skills updated', STAGES_UPDATED: 'Selection stages updated',
};

interface RuleDraft { readonly key: number; ruleType: string; comparator: string; value: string; isBlocking: boolean; readonly locked?: EligibilityRuleDto }
interface SkillDraft { readonly key: number; name: string; taxonomyTopicId: string | null; level: 'REQUIRED' | 'PREFERRED' }
interface StageDraft { readonly key: number; kind: string; label: string; detail: string; scorecardTemplateId: string }
/** EMP-09: the stage kinds whose interviews are scored, and so may carry a scorecard template. */
const scoredStageKinds = ['INTERVIEW', 'GROUP_DISCUSSION'];

let nextKey = 1;
const key = () => nextKey++;

/** The current terms, exactly as they are, so a requirements edit moves nothing else. */
function currentTerms(version: OpportunityVersionTermsDto): Record<string, unknown> {
  const amount = (value: string | null) => value == null || value === '' ? null : Number(value);
  return {
    title: version.title, summary: version.summary, responsibilities: version.responsibilities,
    employmentType: version.employmentType, workMode: version.workMode, locationCity: version.locationCity,
    positionsAvailable: version.positionsAvailable, durationMonths: version.durationMonths,
    compensationDisclosed: version.compensationDisclosed,
    ...(version.compensationDisclosed ? {
      compensationCurrency: version.compensationCurrency, compensationMin: amount(version.compensationMin),
      compensationMax: amount(version.compensationMax), compensationPeriod: version.compensationPeriod,
    } : {}),
    joiningConditions: version.joiningConditions, applicationDeadline: version.applicationDeadline,
  };
}

function toRuleDraft(rule: EligibilityRuleDto): RuleDraft {
  // A college rule is kept exactly as set: the editor has no college picker (audiences target colleges).
  if (rule.ruleType === 'INSTITUTION') return { key: key(), ruleType: rule.ruleType, comparator: rule.comparator, value: rule.valueText ?? '', isBlocking: rule.isBlocking, locked: rule };
  return { key: key(), ruleType: rule.ruleType, comparator: rule.comparator, value: rule.valueNumeric != null ? String(rule.valueNumeric) : rule.valueText ?? '', isBlocking: rule.isBlocking };
}

export function OpportunityRequirementsSection({ requirements, canEdit, editing, busy, onEdit }: {
  readonly requirements: OpportunityRequirementsDto | undefined; readonly canEdit: boolean;
  readonly editing: boolean; readonly busy: boolean; readonly onEdit: () => void;
}): React.ReactElement {
  const rules = requirements?.eligibilityRules ?? [];
  const skills = requirements?.skills ?? [];
  const stages = requirements?.stages ?? [];
  return <section className="role-card role-wide" aria-label="Eligibility, skills and stages">
    <h2>Eligibility, skills and stages</h2>
    <h3>Who can apply</h3>
    {rules.length ? <ul className="hiring-stages">{rules.map((rule, index) => <li key={`${rule.ruleType}-${index}`}>
      {describeEligibilityRule(rule)} {rule.isBlocking ? <span className="hiring-tag">Decides who can apply</span> : <span className="hiring-meta">(shown to students; does not stop anyone applying)</span>}
    </li>)}</ul> : <p>No eligibility rules. Anyone the job reaches can apply.</p>}
    <p className="hiring-meta">Students' CGPA and backlogs come from their academic records. Where their college has not verified a figure, their own declaration is used and marked self-reported on Applicants.</p>
    <h3>Skills</h3>
    {skills.length ? <ul className="hiring-chips">{skills.map((skill) => <li key={skill.name} className={skill.level === 'REQUIRED' ? 'hiring-chip required' : 'hiring-chip'}>
      {skill.name}{skill.level === 'PREFERRED' ? ' (preferred)' : ' (required)'}{skill.catalogue ? '' : ' · not in the ONE catalogue'}
    </li>)}</ul> : <p>No skills listed.</p>}
    <p className="hiring-meta">Catalogue role: {requirements?.careerRole ? `${requirements.careerRole.title} (${requirements.careerRole.code})` : 'None linked'}</p>
    <h3>Selection stages</h3>
    {stages.length ? <ol className="hiring-stages">{stages.map((stage) => <li key={stage.order}>{stage.label} <span className="hiring-meta">({stageKindLabels[stage.kind] ?? stage.kind}){stage.detail ? ` — ${stage.detail}` : ''}</span></li>)}</ol>
      : <p>No stages set. Applicants move through the standard pipeline until you add them.</p>}
    {canEdit
      ? <div className="hiring-actions"><button type="button" className="secondary" disabled={busy} onClick={onEdit}>{editing ? 'Cancel requirements edit' : 'Edit eligibility, skills and stages'}</button></div>
      : <p className="hiring-meta">This job can no longer be edited.</p>}
  </section>;
}

export function OpportunityRequirementsEditor({ employerId, opportunityId, token, version, live, reasonCodes, onSaved, onCancel }: {
  readonly employerId: string; readonly opportunityId: string; readonly token: string;
  readonly version: OpportunityVersionTermsDto; readonly live: boolean; readonly reasonCodes: readonly string[];
  readonly onSaved: (message: string) => void; readonly onCancel: () => void;
}): React.ReactElement {
  const initial = version.requirements;
  const [rules, setRules] = useState<RuleDraft[]>(() => (initial?.eligibilityRules ?? []).map(toRuleDraft));
  const [skills, setSkills] = useState<SkillDraft[]>(() => (initial?.skills ?? []).map((skill) => ({ key: key(), name: skill.name, taxonomyTopicId: skill.taxonomyTopicId, level: skill.level })));
  const [stages, setStages] = useState<StageDraft[]>(() => (initial?.stages ?? []).map((stage) => ({ key: key(), kind: stage.kind, label: stage.label, detail: stage.detail ?? '', scorecardTemplateId: stage.scorecardTemplate?.id ?? '' })));
  // EMP-09: the employer's scorecard templates to choose from; the stages' current ones stay listed even if retired.
  const [templates, setTemplates] = useState<readonly { readonly id: string; readonly name: string; readonly retired: boolean }[]>(() =>
    (initial?.stages ?? []).flatMap((stage) => stage.scorecardTemplate ? [{ id: stage.scorecardTemplate.id, name: stage.scorecardTemplate.name ?? 'Current template', retired: false }] : []));
  useEffect(() => {
    const abort = new AbortController();
    listScorecardTemplates(token, employerId, abort.signal).then((response) => {
      if (abort.signal.aborted) return;
      setTemplates((current) => {
        const loaded = (response.templates ?? []).map((template) => ({ id: template.id, name: template.name, retired: template.retiredAt !== null }));
        return [...loaded, ...current.filter((existing) => !loaded.some((item) => item.id === existing.id))];
      });
    }).catch(() => undefined);
    return () => abort.abort();
  }, [token, employerId]);
  const [careerRoleId, setCareerRoleId] = useState<string>(initial?.careerRole?.id ?? '');
  const [roleOptions, setRoleOptions] = useState<SkillCatalogueDto['careerRoles']>(initial?.careerRole ? [{ ...initial.careerRole, family: '' }] : []);
  const [reasonCode, setReasonCode] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SkillCatalogueDto | null>(null);
  const [freeSkill, setFreeSkill] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const patchRule = (target: number, change: Partial<RuleDraft>) => setRules((current) => current.map((rule) => rule.key === target ? { ...rule, ...change } : rule));
  const patchStage = (target: number, change: Partial<StageDraft>) => setStages((current) => current.map((stage) => stage.key === target ? { ...stage, ...change } : stage));
  const moveStage = (index: number, by: number) => setStages((current) => {
    const next = [...current];
    const [item] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item!);
    return next;
  });

  async function findSkills(): Promise<void> {
    setError('');
    try {
      const found = await searchSkillCatalogue(token, employerId, search);
      setResults(found);
      setRoleOptions((current) => [...current, ...found.careerRoles.filter((role) => !current.some((existing) => existing.id === role.id))]);
    } catch (cause) { setError(formatApiError(cause, 'The skill catalogue could not be searched.')); }
  }

  async function save(): Promise<void> {
    setBusy(true); setError('');
    const body: Record<string, unknown> = {
      ...currentTerms(version),
      expectedCurrentVersionId: version.id,
      eligibilityRules: rules.map((rule) => rule.locked
        ? { ruleType: rule.locked.ruleType, comparator: rule.locked.comparator, valueText: rule.locked.valueText, isBlocking: rule.locked.isBlocking }
        : {
          ruleType: rule.ruleType, comparator: rule.comparator,
          ...(numericComparator(rule.ruleType, rule.comparator) ? { valueNumeric: Number(rule.value) } : { valueText: rule.value }),
          isBlocking: neverBlocks(rule.ruleType) ? false : rule.isBlocking,
        }),
      skills: skills.map((skill) => skill.taxonomyTopicId ? { taxonomyTopicId: skill.taxonomyTopicId, level: skill.level } : { name: skill.name, level: skill.level }),
      stages: stages.map((stage) => ({ kind: stage.kind, label: stage.label, ...(stage.detail.trim() ? { detail: stage.detail } : {}),
        ...(stage.scorecardTemplateId && scoredStageKinds.includes(stage.kind) ? { scorecardTemplateId: stage.scorecardTemplateId } : {}) })),
      careerRoleId: careerRoleId || null,
      ...(reasonCode ? { reasonCode } : {}),
    };
    try {
      const result = await createOpportunityVersion(token, employerId, opportunityId, body);
      const asked = result.applicants.acknowledgementsRequired;
      onSaved(`Saved as version ${result.version.versionNumber}.`
        + (result.version.changedTerms.includes('eligibility')
          ? (asked ? ` Eligibility changed: ${asked} applicant${asked === 1 ? '' : 's'} must accept the new terms before you can move them on.` : ' Eligibility changed; no applicant has to accept anything.')
          : ' No applicant is asked anything.'));
    } catch (cause) {
      setError(formatApiError(cause, 'The new version could not be saved.'));
    } finally { setBusy(false); }
  }

  return <form className="role-card role-wide role-management-form" aria-label="Edit eligibility, skills and stages" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <h2>Edit eligibility, skills and stages — saves version {version.versionNumber + 1}</h2>
    <p>Everything else about the job stays as it is. If you change who can apply on a live job, everyone who has applied is asked to accept the new terms, and you give a reason.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    <fieldset>
      <legend>Who can apply</legend>
      <p className="hiring-meta">Only these rule types exist; nothing may name gender, religion, caste, age, disability, marital status, region of origin or a photo.</p>
      {rules.map((rule) => {
        const definition = editableRuleTypes.find((entry) => entry.type === rule.ruleType);
        if (rule.locked) return <div key={rule.key} className="hiring-actions">
          <span>{describeEligibilityRule(rule.locked)} (kept as set)</span>
          <button type="button" className="secondary" onClick={() => setRules((current) => current.filter((item) => item.key !== rule.key))}>Remove</button>
        </div>;
        return <div key={rule.key} className="hiring-actions" role="group" aria-label="Eligibility rule">
          <label><span>Rule</span><select value={rule.ruleType} onChange={(event) => {
            const next = editableRuleTypes.find((entry) => entry.type === event.target.value)!;
            patchRule(rule.key, { ruleType: next.type, comparator: next.comparators[0]!, value: '', isBlocking: !neverBlocks(next.type) });
          }}>{editableRuleTypes.map((entry) => <option key={entry.type} value={entry.type}>{entry.label}</option>)}</select></label>
          <label><span>Condition</span><select value={rule.comparator} onChange={(event) => patchRule(rule.key, { comparator: event.target.value })}>
            {(definition?.comparators ?? [rule.comparator]).map((comparator) => <option key={comparator} value={comparator}>{comparatorLabels[comparator] ?? comparator}</option>)}
          </select></label>
          <label><span>{numericComparator(rule.ruleType, rule.comparator) ? 'Value' : 'Value (separate several with commas)'}</span>
            <input value={rule.value} required type={numericComparator(rule.ruleType, rule.comparator) ? 'number' : 'text'}
              step={rule.ruleType === 'MIN_CGPA' ? '0.01' : '1'} maxLength={500} onChange={(event) => patchRule(rule.key, { value: event.target.value })} /></label>
          <label className="hiring-checkbox"><input type="checkbox" checked={!neverBlocks(rule.ruleType) && rule.isBlocking} disabled={neverBlocks(rule.ruleType)}
            onChange={(event) => patchRule(rule.key, { isBlocking: event.target.checked })} /><span>Decides who can apply</span></label>
          <button type="button" className="secondary" onClick={() => setRules((current) => current.filter((item) => item.key !== rule.key))}>Remove</button>
        </div>;
      })}
      <button type="button" className="secondary" onClick={() => setRules((current) => [...current, { key: key(), ruleType: 'MIN_CGPA', comparator: 'GTE', value: '', isBlocking: true }])}>Add a rule</button>
    </fieldset>

    <fieldset>
      <legend>Skills</legend>
      {skills.map((skill) => <div key={skill.key} className="hiring-actions" role="group" aria-label="Skill">
        <span>{skill.name}{skill.taxonomyTopicId ? '' : ' (not in the ONE catalogue)'}</span>
        <select aria-label={`Level for ${skill.name}`} value={skill.level} onChange={(event) => setSkills((current) => current.map((item) => item.key === skill.key ? { ...item, level: event.target.value as SkillDraft['level'] } : item))}>
          <option value="REQUIRED">Required</option><option value="PREFERRED">Preferred</option>
        </select>
        <button type="button" className="secondary" onClick={() => setSkills((current) => current.filter((item) => item.key !== skill.key))}>Remove</button>
      </div>)}
      <div className="hiring-actions">
        <label className="student-form-field"><span>Search the ONE skill catalogue</span>
          <input value={search} maxLength={80} onChange={(event) => setSearch(event.target.value)} /></label>
        <button type="button" className="secondary" onClick={() => { void findSkills(); }}>Search</button>
      </div>
      {results ? (results.skills.length
        ? <ul className="hiring-chips" aria-label="Catalogue skills">{results.skills.map((skill) => <li key={skill.taxonomyTopicId} className="hiring-chip">
          <button type="button" className="secondary" disabled={skills.some((item) => item.taxonomyTopicId === skill.taxonomyTopicId)}
            onClick={() => setSkills((current) => [...current, { key: key(), name: skill.name, taxonomyTopicId: skill.taxonomyTopicId, level: 'REQUIRED' }])}>Add {skill.name}</button>
        </li>)}</ul>
        : <p className="hiring-meta">No catalogue skill matches. You can still add it as your own wording below.</p>) : null}
      <div className="hiring-actions">
        <label className="student-form-field"><span>Or add a skill in your own words</span>
          <input value={freeSkill} maxLength={120} onChange={(event) => setFreeSkill(event.target.value)} /></label>
        <button type="button" className="secondary" disabled={!freeSkill.trim()} onClick={() => {
          setSkills((current) => [...current, { key: key(), name: freeSkill.trim(), taxonomyTopicId: null, level: 'REQUIRED' }]); setFreeSkill('');
        }}>Add skill</button>
      </div>
      <label className="student-form-field"><span>Catalogue role this job maps to</span>
        <select value={careerRoleId} onChange={(event) => setCareerRoleId(event.target.value)}>
          <option value="">None</option>
          {roleOptions.map((role) => <option key={role.id} value={role.id}>{`${role.title} (${role.code})`}</option>)}
        </select></label>
      <p className="hiring-meta">Search the catalogue to see roles to choose from.</p>
    </fieldset>

    <fieldset>
      <legend>Selection stages, in order</legend>
      <p className="hiring-meta">Screening, then assessments and group discussions, then interviews; an offer comes last.</p>
      {stages.map((stage, index) => <div key={stage.key} className="hiring-actions" role="group" aria-label={`Stage ${index + 1}`}>
        <span>{index + 1}.</span>
        <label><span>Kind</span><select value={stage.kind} onChange={(event) => patchStage(stage.key, { kind: event.target.value })}>
          {Object.entries(stageKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label><span>Name</span><input value={stage.label} required maxLength={120} onChange={(event) => patchStage(stage.key, { label: event.target.value })} /></label>
        <label><span>Detail (optional)</span><input value={stage.detail} maxLength={1000} onChange={(event) => patchStage(stage.key, { detail: event.target.value })} /></label>
        {scoredStageKinds.includes(stage.kind) ? <label><span>Scorecard template</span><select value={stage.scorecardTemplateId} onChange={(event) => patchStage(stage.key, { scorecardTemplateId: event.target.value })}>
          <option value="">None (free-text scorecard)</option>
          {templates.filter((template) => !template.retired || template.id === stage.scorecardTemplateId).map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select></label> : null}
        <button type="button" className="secondary" disabled={index === 0} onClick={() => moveStage(index, -1)}>Up</button>
        <button type="button" className="secondary" disabled={index === stages.length - 1} onClick={() => moveStage(index, 1)}>Down</button>
        <button type="button" className="secondary" onClick={() => setStages((current) => current.filter((item) => item.key !== stage.key))}>Remove</button>
      </div>)}
      <button type="button" className="secondary" onClick={() => setStages((current) => [...current, { key: key(), kind: 'INTERVIEW', label: '', detail: '', scorecardTemplateId: '' }])}>Add a stage</button>
    </fieldset>

    {live ? <label className="student-form-field"><span>Reason for the change (needed when eligibility changes)</span>
      <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
        <option value="">No reason given</option>
        {reasonCodes.map((code) => <option key={code} value={code}>{reasonLabels[code] ?? code}</option>)}
      </select></label> : null}

    <div className="hiring-actions">
      <button type="submit" disabled={busy}>Save new version</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
