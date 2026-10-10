/**
 * ONE · Consented, per-skill verified evidence on an application (EMP-13, ADR-043).
 *
 * Three pieces, one vocabulary: the student ticks which of their verified evidence to share for
 * one application (while applying, and later from Applications, where anything can be taken back),
 * and the employer reads, on Candidate Detail, exactly those items per job skill — type, source,
 * date and whether it was unaided — or "no evidence shared". Both sides see the same fields, so
 * what is ticked is what is read. There is no total, percentage, score, stage or ranking anywhere,
 * and nothing renders while the feature is off (HG-4 pending): the API says `available: false`.
 *
 * Built only from existing pilot and hiring classes; no new styles.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { ApiRequestError } from './api.js';
import * as dates from './dates.js';
import {
  getEmployerCandidateEvidence,
  getMyApplicationEvidence,
  setMyApplicationEvidence,
  type EmployerCandidateEvidenceDto,
  type EvidenceChoiceDto,
  type EvidenceItemDto,
  type EvidenceSkillDto,
  type StudentApplicationEvidenceDto,
} from './api/hiring.js';

const typeLabels: Readonly<Record<string, string>> = {
  ASSESSMENT_OUTCOME: 'Assessment outcome',
  TOPIC_DEMONSTRATION: 'Topic demonstration',
};
const sourceLabels: Readonly<Record<string, string>> = {
  ONE_SKILL_CHECK: 'ONE skill check',
  INSTITUTION_EXAM: 'Institution exam',
  ONE_RECORD: 'ONE record',
};

function formatDate(value: string | null | undefined): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : dates.formatDate(date);
}

/** One item in words, the same for the student and the employer. */
export function describeEvidence(item: EvidenceItemDto): string {
  return `${typeLabels[item.type] ?? 'Evidence'} · ${sourceLabels[item.source] ?? 'ONE record'} · ${formatDate(item.occurredAt)} · ${item.unaided ? 'unaided' : 'aided (hint or tutor)'}`;
}

function skillHeading(skill: EvidenceSkillDto<unknown>): string {
  return `${skill.name}${skill.level === 'PREFERRED' ? ' (preferred)' : ''}`;
}

const whatIsShared = 'The employer sees only the items you tick, for this application: the skill, the kind of evidence, where it came from, the date and whether it was unaided. Never your readiness, marks, scores or a total. You can take any item back at any time.';

/** The student's checklist, per job skill. */
export function EvidenceChoices({ skills, selected, disabled, onToggle }: {
  readonly skills: readonly EvidenceSkillDto<EvidenceChoiceDto>[];
  readonly selected: ReadonlySet<string>;
  readonly disabled?: boolean;
  readonly onToggle: (evidenceId: string, shared: boolean) => void;
}): React.ReactElement {
  if (!skills.length) return <p className="hiring-meta">This job lists no skills, so there is no evidence to match.</p>;
  return <ul className="hiring-stages" aria-label="Skill evidence to share">{skills.map((skill, index) => <li key={`${skill.name}-${index}`}>
    <strong>{skillHeading(skill)}</strong>
    {!skill.catalogue
      ? <p className="hiring-meta">Not a ONE catalogue skill, so no evidence can be matched to it.</p>
      : skill.items.length === 0
        ? <p className="hiring-meta">You have no verified evidence for this skill yet.</p>
        : skill.items.map((item) => <label key={item.evidenceId} className="hiring-checkbox">
          <input type="checkbox" checked={selected.has(item.evidenceId)} disabled={disabled}
            onChange={(event) => onToggle(item.evidenceId, event.target.checked)} />
          <span>{describeEvidence(item)}</span>
        </label>)}
  </li>)}</ul>;
}

/** The apply-time section; renders nothing while the feature is off. */
export function ApplyEvidenceSection({ evidence, employerName, selected, disabled, onToggle }: {
  readonly evidence: { readonly available: boolean; readonly skills: readonly EvidenceSkillDto<EvidenceChoiceDto>[] } | undefined;
  readonly employerName: string;
  readonly selected: ReadonlySet<string>;
  readonly disabled?: boolean;
  readonly onToggle: (evidenceId: string, shared: boolean) => void;
}): React.ReactElement | null {
  if (!evidence?.available) return null;
  return <div aria-label="Skill evidence">
    <h3>Verified skill evidence to share with {employerName} (optional)</h3>
    <p className="hiring-consent-note">{whatIsShared}</p>
    <EvidenceChoices skills={evidence.skills} selected={selected} disabled={disabled === true} onToggle={onToggle} />
  </div>;
}

/** After applying: change or take back what one application shares. */
export function StudentApplicationEvidenceCard({ applicationId, title, onClose, onChanged }: {
  readonly applicationId: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly onChanged?: () => void;
}): React.ReactElement {
  const [evidence, setEvidence] = useState<StudentApplicationEvidenceDto | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState('Loading your evidence…');
  const [busy, setBusy] = useState(false);

  const show = (loaded: StudentApplicationEvidenceDto): void => {
    setEvidence(loaded);
    setSelected(new Set(loaded.skills.flatMap((skill) => skill.items.filter((item) => item.shared).map((item) => item.evidenceId))));
  };

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    getMyApplicationEvidence(token, applicationId, abort.signal)
      .then((response) => { if (!abort.signal.aborted) { show(response.evidence); setStatus(''); } })
      .catch(() => { if (!abort.signal.aborted) setStatus('Your evidence for this application could not be loaded.'); });
    return () => abort.abort();
  }, [applicationId]);

  async function save(ids: readonly string[], message: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true);
    try {
      const response = await setMyApplicationEvidence(token, applicationId, ids);
      show(response.evidence);
      setStatus(message);
      onChanged?.();
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      setStatus(code === 'APPLICATION_CLOSED' ? 'This application has ended, so nothing new can be shared. You can still take items back.'
        : code === 'EVIDENCE_SHARING_UNAVAILABLE' ? 'Sharing new evidence is not available right now. You can still take items back.'
          : code === 'EVIDENCE_NOT_SHAREABLE' ? 'One of those items can no longer be shared. Reload and choose again.'
            : 'Your choice could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const sharedNow = evidence ? evidence.skills.flatMap((skill) => skill.items.filter((item) => item.shared)).length : 0;
  return <section className="card wide-card" aria-label="Skill evidence for this application">
    <div className="hiring-actions">
      <h2>Skill evidence · {title}</h2>
      <button type="button" className="secondary" onClick={onClose}>Close</button>
    </div>
    <p className="hiring-consent-note">{whatIsShared}</p>
    {status ? <p role="status">{status}</p> : null}
    {evidence ? <>
      {!evidence.canShare ? <p className="hiring-meta">{evidence.available
        ? 'This application has ended, so nothing new can be shared. You can still take items back.'
        : 'Sharing new evidence is not available right now. Anything already shared is listed so you can take it back.'}</p> : null}
      <EvidenceChoices skills={evidence.skills} selected={selected} disabled={busy}
        onToggle={(id, shared) => setSelected((current) => {
          const next = new Set(current);
          if (shared) next.add(id); else next.delete(id);
          return next;
        })} />
      <div className="hiring-actions">
        <button type="button" disabled={busy} onClick={() => { void save([...selected], `Saved. ${evidence.employerName} now sees what is ticked above.`); }}>Save what I share</button>
        {sharedNow > 0 ? <button type="button" className="secondary" disabled={busy}
          onClick={() => { void save([], `Stopped. ${evidence.employerName} no longer sees any of your evidence for this application.`); }}>Stop sharing all evidence</button> : null}
      </div>
    </> : null}
  </section>;
}

/**
 * The employer's Evidence panel on Candidate Detail. Loads its own route (audited by the API); renders
 * nothing while the feature is off, and says plainly when the candidate shares nothing.
 */
export function EmployerEvidencePanel({ employerId, applicationId }: { readonly employerId: string; readonly applicationId: string }): React.ReactElement | null {
  const [evidence, setEvidence] = useState<EmployerCandidateEvidenceDto | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const abort = new AbortController();
    setEvidence(null); setStatus('');
    getEmployerCandidateEvidence(token, employerId, applicationId, abort.signal)
      .then((response) => { if (!abort.signal.aborted) setEvidence(response.evidence ?? null); })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setStatus(error instanceof ApiRequestError && error.status === 403
          ? 'This candidate is no longer sharing their details with you.'
          : 'The evidence this candidate shared could not be loaded.');
      });
    return () => abort.abort();
  }, [employerId, applicationId]);

  if (status) return <section className="role-card role-wide" aria-label="Skill evidence"><h3>Skill evidence</h3><p role="status">{status}</p></section>;
  if (!evidence?.available) return null;
  return <section className="role-card role-wide" aria-label="Skill evidence">
    <h3>Skill evidence</h3>
    <p className="hiring-meta">Verified by ONE from the candidate's graded work, and shown only because they chose to share it for this application. Listed per skill in your job's order. Nothing here is totalled, graded or ranked; weigh each item yourself.</p>
    {evidence.skills.length === 0 ? <p className="hiring-meta">This job lists no skills, so there is no evidence to show.</p>
      : <ul className="hiring-stages" aria-label="Evidence per skill">{evidence.skills.map((skill, index) => <li key={`${skill.name}-${index}`}>
        <strong>{skillHeading(skill)}</strong>
        {!skill.catalogue
          ? <p className="hiring-meta">Not a ONE catalogue skill, so evidence cannot be matched to it.</p>
          : skill.items.length === 0
            ? <p className="hiring-meta">No evidence shared.</p>
            : <ul className="hiring-stages">{skill.items.map((item, itemIndex) => <li key={itemIndex}>
              {describeEvidence(item)} <span className={item.unaided ? 'hiring-tag' : 'hiring-tag warn'}>{item.unaided ? 'Unaided' : 'Aided'}</span>
            </li>)}</ul>}
      </li>)}</ul>}
  </section>;
}
