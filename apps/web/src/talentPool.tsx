/**
 * ONE · The consented talent pool (EMP-14, ADR-044).
 *
 * Two pieces, one vocabulary. The student's Talent pool card on Profile: join explicitly (agreeing to
 * the employer-discovery notice), tick exactly what a card shows — verified evidence per skill, branch,
 * graduation year, preferred cities — see the card as employers would, answer invitations, block
 * employers, and leave at any time. The employer's Talent Pool page: filter (never rank) by skills,
 * branch, year and city, open one card, invite it to apply to an invite-only job, and follow its own
 * invitations. No name, contact, college, score, stage or count anywhere; nothing renders for the
 * student while the feature is switched off, and the employer page keeps its honest
 * not-available state.
 *
 * Built only from existing pilot and hiring classes; no new styles.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { ApiRequestError, searchSkillCatalogue } from './api.js';
import {
  blockEmployer,
  declineTalentPoolInvitation,
  findEmployersToBlock,
  getEmployerTalentPool,
  getMyTalentPool,
  getTalentPoolCard,
  inviteFromTalentPool,
  leaveTalentPool,
  saveMyTalentPool,
  searchTalentPool,
  unblockEmployer,
  type EmployerTalentPoolDto,
  type StudentTalentPoolDto,
  type TalentPoolCardDetailDto,
  type TalentPoolCardDto,
} from './api/talentPool.js';
import { describeEvidence } from './skillEvidence.js';
import { V2EmptyState } from './dashboardsV2.js';
import { StaffPilotWrap } from './parityWraps.js';
import * as dates from './dates.js';

function formatDate(value: string | null | undefined): string {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'not recorded' : dates.formatDate(date);
}

const invitationStateLabels: Readonly<Record<string, string>> = {
  SENT: 'Waiting for your answer', EXPIRED: 'Expired', APPLIED: 'You applied', DECLINED: 'You declined', CANCELLED: 'Cancelled (you blocked this employer)',
};

const whatEmployersSee = 'Verified employers searching the talent pool see a card with only what you tick here: your skills with the evidence you choose (the kind of evidence, where it came from, its date and whether you did it without help), and, if you tick them, your branch, graduation year and preferred cities. Never your name, email, phone, photo, college, marks, scores or readiness. An employer can invite you to apply to a job; nothing about you reaches them unless you apply.';

function errorText(error: unknown, fallback: string): string {
  const code = error instanceof ApiRequestError ? error.code : undefined;
  if (code === 'TALENT_POOL_UNAVAILABLE') return 'The talent pool is not available right now.';
  if (code === 'CONSENT_VERSION_MISMATCH') return 'The notice changed. Reload and read it again before joining.';
  if (code === 'INVALID_PREFERRED_CITIES') return 'Cities must be up to five place names, letters only.';
  if (code === 'EVIDENCE_NOT_SHOWABLE') return 'One of those items can no longer be shown. Reload and choose again.';
  if (code === 'TOO_MANY_EVIDENCE_ITEMS') return 'Choose at most 40 evidence items.';
  if (code === 'INVITATION_NOT_OPEN') return 'That invitation is no longer open.';
  return fallback;
}

/** The student's Talent pool card. Renders nothing while the feature is off and they have not joined. */
export function StudentTalentPoolCard(): React.ReactElement | null {
  const [pool, setPool] = useState<StudentTalentPoolDto | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [showBranch, setShowBranch] = useState(false);
  const [showYear, setShowYear] = useState(false);
  const [cities, setCities] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [employerQuery, setEmployerQuery] = useState('');
  const [employerResults, setEmployerResults] = useState<readonly { readonly employerId: string; readonly name: string }[]>([]);

  const show = (loaded: StudentTalentPoolDto): void => {
    setPool(loaded);
    setShowBranch(loaded.listing?.showBranch ?? false);
    setShowYear(loaded.listing?.showGraduationYear ?? false);
    setCities((loaded.listing?.preferredCities ?? []).join(', '));
    setChosen(new Set(loaded.skills.flatMap((skill) => skill.items.filter((item) => item.shown).map((item) => item.evidenceId))));
  };

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const abort = new AbortController();
    getMyTalentPool(token, abort.signal)
      .then((response) => { if (!abort.signal.aborted && response.talentPool) show(response.talentPool); })
      .catch(() => { if (!abort.signal.aborted) setStatus('Your talent pool settings could not be loaded.'); });
    return () => abort.abort();
  }, []);

  async function act(run: (token: string) => Promise<{ readonly talentPool: StudentTalentPoolDto }>, message: string, fallback: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true);
    try {
      show((await run(token)).talentPool);
      setStatus(message);
    } catch (error) {
      setStatus(errorText(error, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (!pool) return status ? <section className="card wide-card" aria-label="Talent pool"><h2>Talent pool</h2><p role="status">{status}</p></section> : null;
  // Switched off: nothing is offered. Someone who joined while it was on can still leave.
  if (!pool.available) {
    if (!pool.optedIn) return null;
    return <section className="card wide-card" aria-label="Talent pool">
      <span className="eyebrow">Talent pool</span>
      <h2>The talent pool is not available right now</h2>
      <p>No employer can find you while it is unavailable. You joined while it was open; you can leave it now.</p>
      {status ? <p role="status">{status}</p> : null}
      <div className="hiring-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => { void act(leaveTalentPool, 'You have left the talent pool.', 'You could not be removed. Try again.'); }}>Leave the talent pool</button>
      </div>
    </section>;
  }

  const listingInput = {
    showBranch, showGraduationYear: showYear,
    preferredCities: cities.split(',').map((city) => city.trim()).filter(Boolean),
    evidenceRecordIds: [...chosen],
  };
  const join = (): void => { void act((token) => saveMyTalentPool(token, { ...listingInput, consentVersion: pool.consent?.version ?? '' }),
    'You are in the talent pool. Verified employers can now find your card.', 'You could not be added. Try again.'); };
  const findable = pool.optedIn && pool.discoverable;
  const shownSkills = pool.skills.filter((skill) => skill.items.some((item) => chosen.has(item.evidenceId))).map((skill) => skill.name);

  return <section className="card wide-card" aria-label="Talent pool">
    <span className="eyebrow">Talent pool (optional)</span>
    <h2>{pool.consent?.title ?? 'Let verified employers find me in the talent pool'}</h2>
    <p className="hiring-consent-note">{whatEmployersSee}</p>
    <p className={findable ? 'hiring-eligible' : 'hiring-meta'} role="note">{!pool.optedIn
      ? 'You are not in the talent pool. No employer can find you.'
      : findable ? 'You are in the talent pool. Verified employers you have not blocked can find your card.'
        : pool.consent && !pool.consent.granted ? 'You are not findable: the notice changed (or you withdrew it). Agree again below to be findable.'
          : 'You are not findable: your profile visibility is not set to employer discovery. Choose "Make me findable again" below.'}</p>
    {status ? <p role="status">{status}</p> : null}

    <h3>What your card shows</h3>
    <label className="hiring-checkbox"><input type="checkbox" checked={showBranch} disabled={busy} onChange={(event) => setShowBranch(event.target.checked)} />
      <span>My branch: {pool.roster?.branch ?? 'NA (your college has not recorded one)'}</span></label>
    <label className="hiring-checkbox"><input type="checkbox" checked={showYear} disabled={busy} onChange={(event) => setShowYear(event.target.checked)} />
      <span>My graduation year: {pool.roster?.graduationYear ?? 'NA (your college has not recorded one)'}</span></label>
    <label className="student-form-field"><span>Cities I would like to work in (up to five, comma separated)</span>
      <input value={cities} disabled={busy} maxLength={320} onChange={(event) => setCities(event.target.value)} placeholder="Chennai, Hyderabad" /></label>
    <h3>Verified skill evidence to show</h3>
    {pool.skills.length === 0
      ? <p className="hiring-meta">You have no verified skill evidence yet. Evidence appears here once ONE has seen you demonstrate a skill without help on two different days.</p>
      : <ul className="hiring-stages" aria-label="Evidence to show">{pool.skills.map((skill) => <li key={skill.name}>
        <strong>{skill.name}</strong>
        {skill.items.map((item) => <label key={item.evidenceId} className="hiring-checkbox">
          <input type="checkbox" checked={chosen.has(item.evidenceId)} disabled={busy} onChange={(event) => setChosen((current) => {
            const next = new Set(current);
            if (event.target.checked) next.add(item.evidenceId); else next.delete(item.evidenceId);
            return next;
          })} />
          <span>{describeEvidence(item)}</span>
        </label>)}
      </li>)}</ul>}

    <section aria-label="Your card, as employers see it">
      <h3>Your card, as employers see it</h3>
      <ul className="hiring-chips">{shownSkills.length ? shownSkills.map((name) => <li key={name} className="hiring-chip">{name}</li>) : <li className="hiring-chip">No skills shown</li>}</ul>
      <p className="hiring-meta">Branch: {showBranch ? pool.roster?.branch ?? 'NA' : 'hidden'} · Graduation year: {showYear ? pool.roster?.graduationYear ?? 'NA' : 'hidden'} · Cities: {listingInput.preferredCities.join(', ') || 'none'}</p>
    </section>

    <div className="hiring-actions">
      {!pool.optedIn
        ? <button type="button" disabled={busy || !pool.consent} onClick={join}>I agree — add me to the talent pool</button>
        : <>
          <button type="button" disabled={busy} onClick={() => { void act((token) => saveMyTalentPool(token, listingInput), 'Saved. Employers now see your card as shown above.', 'Your card could not be saved. Try again.'); }}>Save my card</button>
          {!pool.discoverable ? <button type="button" className="secondary" disabled={busy || !pool.consent} onClick={join}>I agree — make me findable again</button> : null}
          <button type="button" className="secondary" disabled={busy} onClick={() => { void act(leaveTalentPool, 'You have left the talent pool. Employers can no longer find you.', 'You could not be removed. Try again.'); }}>Leave the talent pool</button>
        </>}
    </div>

    <h3>Invitations to apply</h3>
    {pool.invitations.length === 0 ? <p className="hiring-meta">No invitations yet.</p>
      : <ul className="hiring-list" aria-label="Invitations">{pool.invitations.map((invitation) => <li key={invitation.id} className="hiring-list-item">
        <div>
          <h4>{invitation.title ?? 'NA'}</h4>
          <p className="hiring-meta">{invitation.employerName} · sent {formatDate(invitation.sentAt)} · {invitation.state === 'SENT' ? `open until ${formatDate(invitation.expiresAt)}` : invitationStateLabels[invitation.state] ?? invitation.state}</p>
        </div>
        {invitation.state === 'SENT' ? <div className="hiring-actions">
          <a className="button" href={`/student/opportunities?opportunity=${encodeURIComponent(invitation.opportunityId)}`}>View the job and apply</a>
          <button type="button" className="secondary" disabled={busy} onClick={() => { void act((token) => declineTalentPoolInvitation(token, invitation.id), 'Declined. The employer is not told.', 'The invitation could not be declined.'); }}>Decline</button>
        </div> : null}
      </li>)}</ul>}

    <h3>Employers you have blocked</h3>
    <p className="hiring-meta">A blocked employer never finds your card and cannot invite you. Its open invitations are cancelled.</p>
    {pool.blocks.length === 0 ? <p className="hiring-meta">You have not blocked any employer.</p>
      : <ul className="hiring-list" aria-label="Blocked employers">{pool.blocks.map((block) => <li key={block.employerId} className="hiring-list-item">
        <div><h4>{block.employerName}</h4><p className="hiring-meta">Blocked {formatDate(block.blockedAt)}</p></div>
        <div className="hiring-actions"><button type="button" className="secondary" disabled={busy}
          onClick={() => { void act((token) => unblockEmployer(token, block.employerId), `${block.employerName} is no longer blocked.`, 'The block could not be lifted.'); }}>Unblock</button></div>
      </li>)}</ul>}
    <form className="hiring-search" onSubmit={(event) => {
      event.preventDefault();
      const token = getAccessToken();
      if (!token || employerQuery.trim().length < 2) return;
      findEmployersToBlock(token, employerQuery).then((response) => setEmployerResults(response.employers)).catch(() => setStatus('Employers could not be searched.'));
    }}>
      <label className="student-form-field"><span>Block an employer by name</span>
        <input value={employerQuery} maxLength={80} onChange={(event) => setEmployerQuery(event.target.value)} placeholder="Company name" /></label>
      <button type="submit" className="secondary">Find</button>
    </form>
    {employerResults.length ? <ul className="hiring-list" aria-label="Employers to block">{employerResults.map((employer) => <li key={employer.employerId} className="hiring-list-item">
      <div><h4>{employer.name}</h4></div>
      <div className="hiring-actions"><button type="button" disabled={busy} onClick={() => {
        setEmployerResults([]);
        void act((token) => blockEmployer(token, employer.employerId), `${employer.name} is blocked.`, 'The employer could not be blocked.');
      }}>Block</button></div>
    </li>)}</ul> : null}
  </section>;
}

/** The honest state used while discovery is unavailable (unchanged from EMP-07). */
function TalentPoolNotAvailable(): React.ReactElement {
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Not available yet</span>
      <h1>Talent Pool</h1>
      <p>You can see people who applied to your jobs under Applicants and Candidate Detail.</p>
    </div></div>
    <div className="role-wide"><V2EmptyState icon="🧭" title="Not available yet"
      note="Talent Pool will list students who have chosen to be discoverable by employers. That choice does not exist in ONE yet, so nobody is listed here."
      hint="Nothing is hidden: students appear only after they opt in." /></div>
  </section>;
}

/** The employer's Talent Pool page. */
export function EmployerTalentPoolWorkspace({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [overview, setOverview] = useState<EmployerTalentPoolDto | null>(null);
  const [status, setStatus] = useState('Loading the talent pool…');
  const [skillQuery, setSkillQuery] = useState('');
  const [skillResults, setSkillResults] = useState<readonly { readonly taxonomyTopicId: string; readonly name: string }[]>([]);
  const [skills, setSkills] = useState<readonly { readonly taxonomyTopicId: string; readonly name: string }[]>([]);
  const [branch, setBranch] = useState('');
  const [year, setYear] = useState('');
  const [city, setCity] = useState('');
  const [page, setPage] = useState(0);
  const [cards, setCards] = useState<readonly TalentPoolCardDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [card, setCard] = useState<TalentPoolCardDetailDto | null>(null);
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);

  const loadOverview = async (): Promise<void> => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const response = await getEmployerTalentPool(token, employerId);
    setOverview(response.talentPool ?? { available: false });
  };
  useEffect(() => {
    void loadOverview().then(() => setStatus('')).catch(() => setStatus('The talent pool could not be loaded.'));
  }, [employerId]);

  async function runSearch(nextPage: number): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    if (!skills.length && !branch.trim() && !year.trim() && !city.trim()) { setStatus('Choose at least one skill, branch, graduation year or city.'); return; }
    setBusy(true);
    try {
      const response = await searchTalentPool(token, employerId, { skills: skills.map((skill) => skill.taxonomyTopicId), branch, graduationYear: year, city, page: nextPage });
      setCards(response.talentPool.cards); setHasMore(response.talentPool.hasMore); setPage(nextPage); setCard(null);
      setStatus(response.talentPool.cards.length ? '' : 'No students in the talent pool match these filters.');
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      setStatus(code === 'INVALID_FILTER' ? 'Check the filters: a graduation year has four digits and text is at most 60 characters.' : 'The talent pool could not be searched.');
    } finally {
      setBusy(false);
    }
  }

  async function open(cardRef: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      const response = await getTalentPoolCard(token, employerId, cardRef);
      setCard(response.talentPool.card ?? null);
    } catch (error) {
      setStatus(error instanceof ApiRequestError && error.status === 404 ? 'That student is no longer in the talent pool.' : 'The card could not be opened.');
    }
  }

  async function invite(): Promise<void> {
    const token = getAccessToken();
    if (!token || !card || !jobId) return;
    setBusy(true);
    try {
      await inviteFromTalentPool(token, employerId, card.cardRef, jobId);
      setStatus('Invitation sent. You will see who they are only if they apply.');
      await loadOverview();
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      setStatus(code === 'INVITATION_LIMIT_REACHED' ? 'You have used today\'s invitations. Try again tomorrow.'
        : code === 'ALREADY_INVITED' ? 'You already invited this card to that job.'
          : code === 'CARD_NOT_AVAILABLE' ? 'That student is no longer in the talent pool.'
            : code === 'JOB_NOT_INVITABLE' ? 'That job is not open for invitations. It must be published with the Invite-only audience.'
              : 'The invitation could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  if (!overview) return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>Talent Pool</h1><p role="status">{status}</p></div></div></section>;
  if (!overview.available) return <TalentPoolNotAvailable />;
  const jobs = overview.invitableJobs ?? [];

  return <StaffPilotWrap title="Talent Pool" subtitle="Students who chose to be found. Filter by what they chose to show; every search and card you open is recorded.">
    <section className="role-card role-wide" aria-label="Search the talent pool">
      <h3>Filter</h3>
      <p className="hiring-meta">Results are filtered, never ranked or scored, and show no names, contact details or colleges. A student appears only while they have opted in.</p>
      <form className="hiring-search" onSubmit={(event) => {
        event.preventDefault();
        const token = getAccessToken();
        if (!token || !skillQuery.trim()) return;
        searchSkillCatalogue(token, employerId, skillQuery).then((response) => setSkillResults(response.skills.slice(0, 10))).catch(() => setStatus('Skills could not be searched.'));
      }}>
        <label className="student-form-field"><span>Skill (from the ONE catalogue, up to five)</span>
          <input value={skillQuery} maxLength={80} onChange={(event) => setSkillQuery(event.target.value)} placeholder="SQL, statistics…" /></label>
        <button type="submit" className="secondary">Find skill</button>
      </form>
      {skillResults.length ? <ul className="hiring-chips" aria-label="Skills to add">{skillResults.map((skill) => <li key={skill.taxonomyTopicId} className="hiring-chip">
        <button type="button" className="secondary" disabled={skills.length >= 5 || skills.some((item) => item.taxonomyTopicId === skill.taxonomyTopicId)}
          onClick={() => setSkills((current) => [...current, skill])}>Add {skill.name}</button>
      </li>)}</ul> : null}
      {skills.length ? <ul className="hiring-chips" aria-label="Chosen skills">{skills.map((skill) => <li key={skill.taxonomyTopicId} className="hiring-chip required">
        {skill.name} <button type="button" className="secondary" onClick={() => setSkills((current) => current.filter((item) => item.taxonomyTopicId !== skill.taxonomyTopicId))}>Remove</button>
      </li>)}</ul> : null}
      <label className="student-form-field"><span>Branch</span><input value={branch} maxLength={60} onChange={(event) => setBranch(event.target.value)} placeholder="Computer Science" /></label>
      <label className="student-form-field"><span>Graduation year</span><input value={year} maxLength={4} inputMode="numeric" onChange={(event) => setYear(event.target.value)} placeholder="2027" /></label>
      <label className="student-form-field"><span>Preferred city</span><input value={city} maxLength={60} onChange={(event) => setCity(event.target.value)} placeholder="Chennai" /></label>
      <div className="hiring-actions"><button type="button" disabled={busy} onClick={() => { void runSearch(0); }}>Search the talent pool</button></div>
      {status ? <p role="status">{status}</p> : null}
    </section>

    {cards && cards.length ? <section className="role-card role-wide" aria-label="Matching students">
      <h3>Matching students</h3>
      <ul className="hiring-list">{cards.map((item) => <li key={item.cardRef} className="hiring-list-item">
        <div>
          <h4>Student card {item.cardRef.slice(0, 6)}</h4>
          <ul className="hiring-chips">{item.skills.length ? item.skills.map((name) => <li key={name} className="hiring-chip">{name}</li>) : <li className="hiring-chip">No skills shown</li>}</ul>
          <p className="hiring-meta">Branch: {item.branch ?? 'not shown'} · Graduation year: {item.graduationYear ?? 'not shown'} · Cities: {item.preferredCities.join(', ') || 'not shown'}</p>
        </div>
        <div className="hiring-actions"><button type="button" className="secondary" onClick={() => { void open(item.cardRef); }}>Open card</button></div>
      </li>)}</ul>
      <div className="hiring-actions">
        {page > 0 ? <button type="button" className="secondary" disabled={busy} onClick={() => { void runSearch(page - 1); }}>Previous</button> : null}
        {hasMore ? <button type="button" className="secondary" disabled={busy} onClick={() => { void runSearch(page + 1); }}>Next</button> : null}
      </div>
    </section> : null}

    {card ? <section className="role-card role-wide" aria-label="Student card">
      <h3>Student card {card.cardRef.slice(0, 6)}</h3>
      <p className="hiring-meta">Branch: {card.branch ?? 'not shown'} · Graduation year: {card.graduationYear ?? 'not shown'} · Cities: {card.preferredCities.join(', ') || 'not shown'}</p>
      <p className="hiring-meta">Verified by ONE from the student's graded work and shown because they chose to. Nothing here is totalled, graded or ranked.</p>
      {card.skills.length === 0 ? <p className="hiring-meta">This student shows no skill evidence.</p>
        : <ul className="hiring-stages" aria-label="Evidence per skill">{card.skills.map((skill) => <li key={skill.name}>
          <strong>{skill.name}</strong>
          <ul className="hiring-stages">{skill.items.map((item, index) => <li key={index}>
            {describeEvidence(item)} <span className={item.unaided ? 'hiring-tag' : 'hiring-tag warn'}>{item.unaided ? 'Unaided' : 'Aided'}</span>
          </li>)}</ul>
        </li>)}</ul>}
      <h3>Invite to apply</h3>
      {jobs.length === 0
        ? <p className="hiring-meta">Publish a job with the Invite-only audience to invite students from the talent pool.</p>
        : <>
          <label className="student-form-field"><span>Job</span>
            <select value={jobId} onChange={(event) => setJobId(event.target.value)}>
              <option value="">Select an invite-only job</option>
              {jobs.map((item) => <option key={item.opportunityId} value={item.opportunityId}>{item.title}{item.referenceCode ? ` (${item.referenceCode})` : ''}</option>)}
            </select></label>
          <div className="hiring-actions"><button type="button" disabled={busy || !jobId || overview.invitationsLeftToday === 0} onClick={() => { void invite(); }}>Send invitation</button></div>
        </>}
      <p className="hiring-meta">{typeof overview.invitationsLeftToday === 'number' && typeof overview.dailyInvitationLimit === 'number'
        ? `Invitations left today: ${overview.invitationsLeftToday} of ${overview.dailyInvitationLimit}. ` : ''}The student is told in ONE; you learn who they are only if they apply.</p>
    </section> : null}

    <section className="role-card role-wide" aria-label="Your invitations">
      <h3>Your invitations</h3>
      {(overview.invitations ?? []).length === 0 ? <p className="hiring-meta">You have not invited anyone yet.</p>
        : <ul className="hiring-list">{(overview.invitations ?? []).map((item, index) => <li key={index} className="hiring-list-item">
          <div><h4>{item.title ?? 'A role you posted'}</h4><p className="hiring-meta">Sent {formatDate(item.sentAt)} · open until {formatDate(item.expiresAt)}</p></div>
          <span className="hiring-tag">{item.status === 'APPLIED' ? 'Applied — see Applicants' : item.status === 'PENDING' ? 'No answer yet' : 'Closed'}</span>
        </li>)}</ul>}
    </section>
  </StaffPilotWrap>;
}
