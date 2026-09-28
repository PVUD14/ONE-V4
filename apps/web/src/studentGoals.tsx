/**
 * Student goals and onboarding on the web (ENG-19), shown at the top of My Career.
 *
 * Why it exists: the first thing ONE asks a new student — or a graduate who has already left college — is
 * "What job do you want?". This panel asks it (catalogue search with synonyms, and "Not sure yet" with a short
 * survey and 3–5 suggested roles), then shows the student's goals: one primary role, any number of topics, and
 * exam or company goals where the catalogue is open. Skills needed by several goals are listed once. It uses
 * the pilot design system, adds no navigation, shows statuses and reasons only (never a readiness value or a
 * score), and says NA when something cannot be loaded rather than inventing it.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  endLearnerGoal,
  getCareerDiscovery,
  getLearnerGoals,
  searchGoalOptions,
  setLearnerGoal,
  submitCareerDiscovery,
  type CareerDiscoveryDto,
  type GoalOptionsDto,
  type GoalOrigin,
  type GoalRoleOptionDto,
  type GoalSkillStatus,
  type LearnerGoalDto,
  type LearnerGoalsDto,
  type SetGoalInput,
} from './api.js';

const GOAL_TYPE_LABEL: Readonly<Record<LearnerGoalDto['goalType'], string>> = {
  ROLE: 'Role', TOPIC: 'Topic', EXAM: 'Exam', COMPANY: 'Company prep', DISCOVERY: 'Not sure yet',
};

const STATUS_LABEL: Readonly<Record<GoalSkillStatus, string>> = {
  MET: 'Met', PARTIAL: 'Partly met', MISSING: 'Not met yet', UNKNOWN: 'Not measured yet',
};

function goalTitle(goal: LearnerGoalDto): string {
  return goal.role?.title ?? goal.topic?.name ?? goal.catalogueGoal?.title ?? 'Exploring roles';
}

function ReleaseChip({ label }: { readonly label: 'SELECTABLE' | 'VERIFIED' | null }): React.ReactElement | null {
  if (label === 'VERIFIED') return <span className="pilot-chip green">Verified</span>;
  if (label === 'SELECTABLE') return <span className="pilot-chip slate">Not yet verified</span>;
  return null;
}

export function StudentGoalsPanel(): React.ReactElement {
  const [goals, setGoals] = useState<LearnerGoalsDto | null>(null);
  const [status, setStatus] = useState('Loading your goals…');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'search' | 'discovery'>('search');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return undefined; }
    const controller = new AbortController();
    getLearnerGoals(token, controller.signal)
      .then((loaded) => {
        // A response without the goals list is treated as unavailable, never guessed at.
        if (!Array.isArray(loaded?.goals) || !Array.isArray(loaded?.skills?.skills)) throw new Error('unexpected goals response');
        setGoals(loaded); setStatus('');
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('NA — your goals could not be loaded right now.'); });
    return () => controller.abort();
  }, []);

  async function choose(input: SetGoalInput, done: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      setGoals(await setLearnerGoal(token, input));
      setNotice(done);
      setMode('search');
    } catch (error) {
      setNotice((error as { detail?: string }).detail ?? 'That goal could not be set. Try again.');
    }
  }

  async function end(goal: LearnerGoalDto, next: 'ACHIEVED' | 'WITHDRAWN'): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      setGoals(await endLearnerGoal(token, goal.id, next));
      setNotice(next === 'ACHIEVED' ? `Marked “${goalTitle(goal)}” as achieved.` : `Removed “${goalTitle(goal)}” from your goals.`);
    } catch (error) {
      setNotice((error as { detail?: string }).detail ?? 'That goal could not be changed. Try again.');
    }
  }

  if (!goals) {
    return <section className="pilot-card"><div className="pilot-card-head"><h2>Your goals</h2><span className="pilot-chip slate">NA</span></div><p style={{ color: 'var(--p-muted)' }}>{status}</p></section>;
  }

  const hasPrimary = goals.goals.some((goal) => goal.priority === 'PRIMARY');
  const onboardingRole = goals.onboarding || !hasPrimary;

  return <>
    {notice ? <p role="status" className="pilot-chip blue" style={{ display: 'inline-block', marginBottom: 10 }}>{notice}</p> : null}
    {onboardingRole ? (
      <section className="pilot-card" aria-labelledby="onboarding-question">
        <div className="pilot-card-head"><h2 id="onboarding-question">What job do you want?</h2><span className="pilot-chip purple">Start here</span></div>
        <p style={{ color: 'var(--p-muted)', margin: '4px 0 12px' }}>Pick the role you are aiming at. Your gaps and next steps are measured against it. Whether you are studying now or finished college already, this works the same.</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button type="button" className={`pilot-btn small ${mode === 'search' ? '' : 'ghost'}`} onClick={() => setMode('search')}>Search roles</button>
          <button type="button" className={`pilot-btn small ${mode === 'discovery' ? '' : 'ghost'}`} onClick={() => setMode('discovery')}>Not sure yet</button>
        </div>
        {mode === 'search'
          ? <GoalSearch purpose="role" onChooseRole={(role) => void choose({ goalType: 'ROLE', careerRoleId: role.id, priority: 'PRIMARY', origin: goals.onboarding ? 'ONBOARDING' : 'GOALS' }, `${role.title} is now your main goal.`)} />
          : <DiscoveryPanel origin={goals.onboarding ? 'ONBOARDING' : 'GOALS'} onChoose={(role) => void choose({ goalType: 'ROLE', careerRoleId: role.id, priority: 'PRIMARY', origin: 'DISCOVERY_SUGGESTION' }, `${role.title} is now your main goal.`)} />}
      </section>
    ) : null}

    {goals.goals.length ? <section className="pilot-card">
      <div className="pilot-card-head"><h2>Your goals</h2><span className="pilot-chip blue">{goals.goals.length} live</span></div>
      <div className="pilot-list">
        {goals.goals.map((goal) => <div key={goal.id} className="pilot-list-row" style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <strong style={{ fontSize: 13 }}>{goalTitle(goal)}</strong>
            <small style={{ display: 'block', color: 'var(--p-muted)' }}>{GOAL_TYPE_LABEL[goal.goalType]}{goal.role ? ` · ${goal.role.family}` : ''}</small>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {goal.priority === 'PRIMARY' ? <span className="pilot-chip purple">Main goal</span> : null}
            {goal.role ? <ReleaseChip label={goal.role.releaseLabel} /> : null}
            {goal.catalogueGoal ? <span className="pilot-chip slate">Not yet verified</span> : null}
            {goal.goalType !== 'ROLE' && goal.goalType !== 'DISCOVERY'
              ? <button type="button" className="pilot-btn soft small" onClick={() => void end(goal, 'ACHIEVED')}>Mark achieved</button> : null}
            <button type="button" className="pilot-btn ghost small" aria-label={`Remove ${goalTitle(goal)}`} onClick={() => void end(goal, 'WITHDRAWN')}>Remove</button>
          </div>
        </div>)}
      </div>
    </section> : null}

    {!goals.onboarding ? <section className="pilot-card">
      <div className="pilot-card-head"><h2>Add a goal</h2></div>
      <p style={{ color: 'var(--p-muted)', margin: '4px 0 12px' }}>Add topics you want to learn{goals.catalogueOpen ? ', exams or company preparation' : ''}, or another role to keep in view. Work on a topic counts toward every role that needs it.</p>
      <GoalSearch purpose="any" onChooseRole={(role) => void choose({ goalType: 'ROLE', careerRoleId: role.id, priority: hasPrimary ? 'SECONDARY' : 'PRIMARY', origin: 'GOALS' }, `Added ${role.title}.`)}
        onChooseTopic={(topic) => void choose({ goalType: 'TOPIC', topicId: topic.id, origin: 'GOALS' }, `Added ${topic.name}.`)}
        onChooseCatalogueGoal={(goal) => void choose({ goalType: goal.goalType, catalogueGoalCode: goal.code, origin: 'GOALS' }, `Added ${goal.title}.`)} />
    </section> : null}

    {!goals.onboarding ? <section className="pilot-card">
      <div className="pilot-card-head"><h2>Skills across your goals</h2><span className="pilot-chip slate">Each skill once</span></div>
      {goals.skills.skills.length === 0
        ? <p style={{ color: 'var(--p-muted)' }}>NA — none of your goals lists skills yet. Exam and company goals get skills when their tracks are published.</p>
        : <div className="pilot-list">
          {goals.skills.skills.map((skill) => <div key={skill.topicId} className="pilot-list-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <div>
              <strong style={{ fontSize: 13 }}>{skill.topicTitle ?? 'Topic'}</strong>
              <small style={{ display: 'block', color: 'var(--p-muted)' }}>Needed by {skill.goals.length === 1 ? 'one of your goals' : `${skill.goals.length} of your goals`}</small>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {skill.goals.map((goal) => {
                const owner = goals.goals.find((entry) => entry.id === goal.goalId);
                const label = goal.status ? STATUS_LABEL[goal.status] : 'Your topic goal';
                return <span key={goal.goalId} className={`pilot-chip ${goal.status === 'MET' ? 'green' : goal.status === 'UNKNOWN' || goal.status === null ? 'slate' : 'amber'}`}>
                  {owner ? `${goalTitle(owner)}: ` : ''}{label}
                </span>;
              })}
            </div>
          </div>)}
        </div>}
    </section> : null}
  </>;
}

function GoalSearch({ purpose, onChooseRole, onChooseTopic, onChooseCatalogueGoal }: {
  readonly purpose: 'role' | 'any';
  readonly onChooseRole: (role: GoalRoleOptionDto) => void;
  readonly onChooseTopic?: (topic: { readonly id: string; readonly name: string }) => void;
  readonly onChooseCatalogueGoal?: (goal: GoalOptionsDto['catalogueGoals'][number]) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<GoalOptionsDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchGoalOptions(token, query.trim(), controller.signal)
        .then((found) => { setOptions(found); setFailed(false); })
        .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    }, query ? 250 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  const roles = options?.roles ?? [];
  const topics = purpose === 'any' ? options?.topics ?? [] : [];
  const catalogueGoals = purpose === 'any' ? options?.catalogueGoals ?? [] : [];
  const nothing = options !== null && roles.length === 0 && topics.length === 0 && catalogueGoals.length === 0;

  return <div>
    <label className="pilot-field">
      <span>{purpose === 'role' ? 'Search by job title' : 'Search roles and topics'}</span>
      <input value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} placeholder={purpose === 'role' ? 'For example: analyst, developer, design' : 'For example: SQL, communication'} />
    </label>
    {failed ? <p style={{ color: 'var(--p-muted)' }}>NA — the list could not be loaded right now.</p> : null}
    {options === null && !failed ? <p style={{ color: 'var(--p-muted)' }}>Loading…</p> : null}
    {nothing ? <p style={{ color: 'var(--p-muted)' }}>{query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing is available to choose yet.'}</p> : null}
    {roles.length ? <div className="pilot-list" aria-label="Roles">
      {roles.map((role) => <div key={role.id} className="pilot-list-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div>
          <strong style={{ fontSize: 13 }}>{role.title}</strong>
          <small style={{ display: 'block', color: 'var(--p-muted)' }}>{[role.catalogueCode, role.family].filter(Boolean).join(' · ')}{role.matchedSynonym ? ` · also called “${role.matchedSynonym}”` : ''}</small>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <ReleaseChip label={role.releaseLabel} />
          <button type="button" className="pilot-btn soft small" aria-label={`Choose ${role.title}`} onClick={() => onChooseRole(role)}>Choose</button>
        </div>
      </div>)}
    </div> : null}
    {topics.length && onChooseTopic ? <div className="pilot-list" aria-label="Topics" style={{ marginTop: 10 }}>
      {topics.map((topic) => <div key={topic.id} className="pilot-list-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div><strong style={{ fontSize: 13 }}>{topic.name}</strong><small style={{ display: 'block', color: 'var(--p-muted)' }}>Topic</small></div>
        <button type="button" className="pilot-btn soft small" aria-label={`Add topic ${topic.name}`} onClick={() => onChooseTopic(topic)}>Add</button>
      </div>)}
    </div> : null}
    {catalogueGoals.length && onChooseCatalogueGoal ? <div className="pilot-list" aria-label="Exams and company preparation" style={{ marginTop: 10 }}>
      {catalogueGoals.map((goal) => <div key={goal.code} className="pilot-list-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div><strong style={{ fontSize: 13 }}>{goal.title}</strong><small style={{ display: 'block', color: 'var(--p-muted)' }}>{goal.goalType === 'EXAM' ? 'Exam' : 'Company prep'}</small></div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="pilot-chip slate">Not yet verified</span>
          <button type="button" className="pilot-btn soft small" aria-label={`Add ${goal.title}`} onClick={() => onChooseCatalogueGoal(goal)}>Add</button>
        </div>
      </div>)}
    </div> : null}
  </div>;
}

function reasonText(reason: { readonly code: string; readonly detail?: string }, survey: CareerDiscoveryDto['survey']): string {
  const labelOf = (list: readonly { readonly code: string; readonly label: string }[]): string => list.find((entry) => entry.code === reason.detail)?.label ?? '';
  switch (reason.code) {
    case 'INTEREST_MATCH': return `Matches your interest: ${labelOf(survey.interests).toLowerCase()}`;
    case 'STRENGTH_MATCH': return `Uses a strength you named: ${labelOf(survey.strengths).toLowerCase()}`;
    case 'BRANCH_MATCH': return `Named for your branch (${reason.detail ?? ''})`;
    case 'SHOWN_SKILLS': return 'Builds on skills you have already shown';
    case 'OPEN_TO_YOUR_BRANCH': return `Open to your branch (${reason.detail ?? ''})`;
    default: return 'Open to every branch';
  }
}

function DiscoveryPanel({ origin, onChoose }: { readonly origin: GoalOrigin; readonly onChoose: (role: GoalRoleOptionDto) => void }): React.ReactElement {
  const [discovery, setDiscovery] = useState<CareerDiscoveryDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [interests, setInterests] = useState<string[]>([]);
  const [strengths, setStrengths] = useState<string[]>([]);
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return undefined;
    const controller = new AbortController();
    getCareerDiscovery(token, controller.signal).then((loaded) => {
      if (!Array.isArray(loaded?.discovery?.survey?.interests)) throw new Error('unexpected discovery response');
      setDiscovery(loaded.discovery);
      if (loaded.discovery.answers) {
        setInterests([...loaded.discovery.answers.interests]);
        setStrengths([...loaded.discovery.answers.strengths]);
        setBranch(loaded.discovery.answers.branch);
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  if (failed) return <p style={{ color: 'var(--p-muted)' }}>NA — the survey could not be loaded right now.</p>;
  if (!discovery) return <p style={{ color: 'var(--p-muted)' }}>Loading…</p>;

  const toggle = (list: string[], set: (next: string[]) => void, code: string): void => {
    set(list.includes(code) ? list.filter((entry) => entry !== code) : list.length >= 3 ? list : [...list, code]);
  };

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token) return;
    if (interests.length === 0) { setError('Choose at least one kind of work.'); return; }
    if (!branch) { setError('Choose your branch or degree, or “Not listed”.'); return; }
    try {
      const saved = (await submitCareerDiscovery(token, { interests, strengths, branch, origin })).discovery;
      if (!Array.isArray(saved?.survey?.interests)) throw new Error('unexpected discovery response');
      setDiscovery(saved);
      setError('');
    } catch (failure) {
      setError((failure as { detail?: string }).detail ?? 'Your answers could not be saved. Try again.');
    }
  }

  const result = discovery.result;
  return <div>
    <form onSubmit={(event) => void submit(event)}>
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>What kind of work interests you? (up to three)</legend>
        {discovery.survey.interests.map((entry) => <label key={entry.code} style={{ display: 'block', fontSize: 13, margin: '3px 0' }}>
          <input type="checkbox" checked={interests.includes(entry.code)} onChange={() => toggle(interests, setInterests, entry.code)} /> {entry.label}
        </label>)}
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>What are you good at? (optional, up to three)</legend>
        {discovery.survey.strengths.map((entry) => <label key={entry.code} style={{ display: 'block', fontSize: 13, margin: '3px 0' }}>
          <input type="checkbox" checked={strengths.includes(entry.code)} onChange={() => toggle(strengths, setStrengths, entry.code)} /> {entry.label}
        </label>)}
      </fieldset>
      <label className="pilot-field">
        <span>Which branch or degree did you study?</span>
        <select value={branch} onChange={(event) => setBranch(event.target.value)}>
          <option value="">Choose…</option>
          {discovery.survey.branches.map((entry) => <option key={entry} value={entry}>{entry === 'NOT_LISTED' ? 'Not listed' : entry}</option>)}
        </select>
      </label>
      {error ? <p role="alert" style={{ color: 'var(--p-rose)' }}>{error}</p> : null}
      <button type="submit" className="pilot-btn small">Show suggestions</button>
    </form>
    {result ? <div style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>Roles to consider</h3>
      <small style={{ display: 'block', color: 'var(--p-muted)', marginBottom: 8 }}>
        {result.usedShownSkills ? 'From your answers and the skills you have shown.' : 'From your answers only — your learning history was not used.'}
      </small>
      {result.suggestions.length === 0
        ? <p style={{ color: 'var(--p-muted)' }}>No roles are available to suggest yet. Search by job title instead.</p>
        : <div className="pilot-list">
          {result.suggestions.map((suggestion) => <div key={suggestion.role.id} className="pilot-list-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
            <div>
              <strong style={{ fontSize: 13 }}>{suggestion.role.title}</strong>
              <ul style={{ margin: '3px 0 0', paddingLeft: 16, color: 'var(--p-muted)', fontSize: 12 }}>
                {suggestion.reasons.map((reason) => <li key={`${reason.code}-${reason.detail ?? ''}`}>{reasonText(reason, discovery.survey)}</li>)}
              </ul>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <ReleaseChip label={suggestion.role.releaseLabel} />
              <button type="button" className="pilot-btn soft small" aria-label={`Choose ${suggestion.role.title}`} onClick={() => onChoose(suggestion.role)}>Choose</button>
            </div>
          </div>)}
        </div>}
      {result.fewerThanMinimum && result.suggestions.length > 0 ? <p style={{ color: 'var(--p-muted)', fontSize: 12 }}>Only {result.suggestions.length === 1 ? 'one role is' : `${result.suggestions.length} roles are`} available to suggest right now.</p> : null}
    </div> : null}
  </div>;
}
