/**
 * Demo-site operations portal: AI8HT's platform operations desk. It shows how a
 * college is onboarded (organisation, checks, first admin invitation, roster, live),
 * how employers are verified before they can hire, staff invitations, the reviewed
 * question bank and the audit trail.
 *
 * Fictional, demo-site only. The colleges and employers are the same fictional names
 * the other demo portals use, so the story stays consistent.
 */
import { useState } from 'react';
import { Activity, Building2, CheckCircle2, ClipboardList, FileSearch, GraduationCap, Library, MailCheck, Plus, ShieldCheck, Users } from 'lucide-react';
import { DetailRows, OverlayForm, useOverlay } from '../pilot/pilotOverlay.js';
import { Funnel, KpiRow, PageHead, wired } from './demoKit.js';

export const operationsPersona = {
  name: 'Ananya Kulkarni',
  initials: 'AK',
  role: 'Platform Operations · AI8HT',
  email: 'ananya.ops@one.example',
} as const;

const ONBOARDING_STAGES = ['Contract signed', 'Admin invited', 'Roster imported', 'Live'] as const;
type OnboardingStage = typeof ONBOARDING_STAGES[number];

interface College {
  readonly name: string;
  readonly city: string;
  readonly kind: string;
  readonly students: number;
  readonly stage: OnboardingStage;
  readonly admin: string;
}

const COLLEGES: readonly College[] = [
  { name: 'Lakeview Institute of Technology', city: 'Chennai', kind: 'Engineering', students: 1284, stage: 'Live', admin: 'Prof. Meera Nair' },
  { name: 'Riverside College of Engineering', city: 'Tiruchirappalli', kind: 'Engineering', students: 940, stage: 'Live', admin: 'Dr. R. Natarajan' },
  { name: 'Hillcrest University', city: 'Coimbatore', kind: 'University', students: 716, stage: 'Roster imported', admin: 'Ms. Farah Siddiqui' },
  { name: 'Coastal Engineering College', city: 'Puducherry', kind: 'Engineering', students: 0, stage: 'Admin invited', admin: 'Invitation sent to placement head' },
  { name: 'Sunrise Arts & Science College', city: 'Madurai', kind: 'Arts & Science', students: 0, stage: 'Contract signed', admin: 'Not yet invited' },
];

const STAGE_TONE: Readonly<Record<OnboardingStage, string>> = {
  'Contract signed': 'slate', 'Admin invited': 'amber', 'Roster imported': 'blue', Live: 'green',
};

interface EmployerRequest {
  readonly company: string;
  readonly requester: string;
  readonly checks: readonly (readonly [string, boolean])[];
  readonly received: string;
}

const EMPLOYER_QUEUE: readonly EmployerRequest[] = [
  { company: 'Brightpath Fintech', requester: 'Neha Varghese · Talent Acquisition', received: 'Today', checks: [['Work email on company domain', true], ['Company registration (CIN) found', true], ['Website matches the company', true]] },
  { company: 'QuickHire Staffing', requester: 'Recruiter · free email address', received: 'Yesterday', checks: [['Work email on company domain', false], ['Company registration (CIN) found', true], ['Website matches the company', false]] },
];

const VERIFIED_EMPLOYERS = [
  ['Zenvia Labs', 'Verified 4 Mar 2026 · 6 open roles'],
  ['Kortex Systems', 'Verified 11 Feb 2026 · 3 open roles'],
  ['BlueRiver Analytics', 'Verified 2 Apr 2026 · 2 open roles'],
  ['Veridian Tech', 'Verified 19 Mar 2026 · 4 open roles'],
] as const;

const INVITATIONS = [
  { email: 'placement.head@coastal.example', role: 'College admin · Coastal Engineering College', sent: '2 days ago', status: 'Sent' },
  { email: 'farah.s@hillcrest.example', role: 'College admin · Hillcrest University', sent: '9 days ago', status: 'Accepted' },
  { email: 'hod.cse@hillcrest.example', role: 'Department head · Hillcrest University', sent: '6 days ago', status: 'Accepted' },
  { email: 'tpo@riverside.example', role: 'Placement officer · Riverside College', sent: '24 days ago', status: 'Expired' },
] as const;

const QUESTION_BANKS = [
  { bank: 'Quantitative aptitude', questions: 1240, review: 18, owner: 'Assessment team' },
  { bank: 'Verbal ability', questions: 860, review: 6, owner: 'Assessment team' },
  { bank: 'Programming & data structures', questions: 1980, review: 41, owner: 'CSE panel' },
  { bank: 'Databases & SQL', questions: 640, review: 12, owner: 'CSE panel' },
  { bank: 'Communication scenarios', questions: 320, review: 0, owner: 'Soft-skills panel' },
] as const;

const AUDIT = [
  { when: '09:42', who: 'Ananya Kulkarni', what: 'Verified employer', target: 'Veridian Tech — new recruiter added' },
  { when: '09:15', who: 'Prof. Meera Nair', what: 'Imported roster', target: 'Lakeview · Batch 2028 · 117 students' },
  { when: '08:58', who: 'Ananya Kulkarni', what: 'Sent admin invitation', target: 'Coastal Engineering College' },
  { when: 'Yesterday', who: 'Ravi Menon', what: 'Changed feature flag', target: 'Campus drives — on for Hillcrest University (second approver: Ananya Kulkarni)' },
  { when: 'Yesterday', who: 'Ananya Kulkarni', what: 'Published question set', target: 'Databases & SQL — 24 questions after review' },
] as const;

export function OperationsOverview({ onNavigate }: { readonly onNavigate: (key: string) => void }): React.ReactElement {
  const live = COLLEGES.filter((college) => college.stage === 'Live').length;
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Operations Overview" detail="Colleges coming onto ONE, employers waiting for verification, and the health of the platform." />
      <KpiRow items={[
        ['Colleges Live', live, 'green', GraduationCap],
        ['Colleges Onboarding', COLLEGES.length - live, 'amber', Building2],
        ['Verified Employers', 14, 'blue', ShieldCheck],
        ['Employers Waiting', EMPLOYER_QUEUE.length, 'rose', FileSearch],
        ['Active Students', '2,940', 'indigo', Users],
      ]} />
      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>College Onboarding</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('colleges'))}>Open Colleges</button></div>
          <Funnel tone="green" rows={ONBOARDING_STAGES.map((stage) => ({ label: stage, value: COLLEGES.filter((college) => ONBOARDING_STAGES.indexOf(college.stage) >= ONBOARDING_STAGES.indexOf(stage)).length }))} />
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Employer Verification</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('employers'))}>Open Queue</button></div>
          <div className="pilot-list">
            {EMPLOYER_QUEUE.map((request) => (
              <div key={request.company} className="pilot-list-row">
                <span className="pilot-tile amber"><FileSearch size={16} /></span>
                <div className="grow"><strong>{request.company}</strong><small>{request.requester} · {request.received}</small></div>
                <span className="pilot-chip amber">{request.checks.filter(([, ok]) => ok).length}/{request.checks.length} checks</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>Platform Health</h2>
        <div className="pilot-list">
          {[['Web and API', 'Operating normally'], ['Background jobs', 'Queue clear'], ['Database backups', 'Last backup 02:00 today'], ['Outgoing email', 'Delivering']].map(([label, state]) => (
            <div key={label} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <CheckCircle2 size={15} color="#0d6b4f" />
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{label}</strong><small>{state}</small></div>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recent Activity</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('audit'))}>Audit Log</button></div>
        <div className="pilot-list">
          {AUDIT.slice(0, 3).map((entry) => (
            <div key={`${entry.when}-${entry.target}`} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <span className="pilot-tile slate" style={{ width: 30, height: 30 }}><Activity size={13} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{entry.what}</strong><small>{entry.target}</small></div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}

/**
 * The onboarding wizard: organisation details, checks, first admin invitation. It ends
 * with the college in the table at "Admin invited" - the admin then imports the roster.
 */
function OnboardCollegeBody({ onDone }: { readonly onDone: (college: College) => void }): React.ReactElement {
  const overlay = useOverlay();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('Greenfield Polytechnic College');
  const [city, setCity] = useState('Salem');
  const [admin, setAdmin] = useState('principal@greenfield.example');
  const steps = ['College details', 'Checks', 'First admin', 'Done'];
  return <div>
    <div className="pilot-phases" style={{ marginBottom: 12 }}>
      {steps.map((label, index) => (
        <span key={label} className={`pilot-phase ${index === step ? 'active' : ''}`}><strong>{index + 1}. {label}</strong></span>
      ))}
    </div>
    {step === 0 ? <div>
      <label className="pilot-field"><span>College name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="pilot-field"><span>City</span><input value={city} onChange={(event) => setCity(event.target.value)} /></label>
      <label className="pilot-field"><span>Type</span><select defaultValue="Polytechnic"><option>Engineering</option><option>Polytechnic</option><option>Arts &amp; Science</option><option>University</option></select></label>
      <div className="pilot-modal-actions"><button type="button" className="pilot-btn" onClick={() => setStep(1)}>Continue</button></div>
    </div> : null}
    {step === 1 ? <div>
      <div className="pilot-list">
        {[['Signed agreement on file', true], ['College email domain confirmed (greenfield.example)', true], ['Placement head identified', true]].map(([label]) => (
          <div key={label as string} className="pilot-list-row" style={{ padding: '7px 2px' }}>
            <CheckCircle2 size={15} color="#0d6b4f" /><div className="grow"><small style={{ color: 'var(--p-ink-2)' }}>{label as string}</small></div>
          </div>
        ))}
      </div>
      <div className="pilot-modal-actions">
        <button type="button" className="pilot-btn ghost" onClick={() => setStep(0)}>Back</button>
        <button type="button" className="pilot-btn" onClick={() => setStep(2)}>Mark Verified</button>
      </div>
    </div> : null}
    {step === 2 ? <div>
      <p className="pilot-modal-text">The first college admin sets up departments and batches, adds staff and uploads the student roster. ONE never creates student accounts for them.</p>
      <label className="pilot-field"><span>Admin email</span><input type="email" value={admin} onChange={(event) => setAdmin(event.target.value)} /></label>
      <div className="pilot-modal-actions">
        <button type="button" className="pilot-btn ghost" onClick={() => setStep(1)}>Back</button>
        <button type="button" className="pilot-btn" onClick={() => {
          setStep(3);
          onDone({ name: name || 'Greenfield Polytechnic College', city: city || 'Salem', kind: 'Polytechnic', students: 0, stage: 'Admin invited', admin: `Invitation sent to ${admin}` });
        }}><MailCheck size={14} /> Send Invitation</button>
      </div>
    </div> : null}
    {step === 3 ? <div>
      <div className="pilot-banner"><CheckCircle2 size={17} /> {name} is on ONE. The admin invitation is on its way.</div>
      <p className="pilot-modal-text" style={{ marginTop: 12 }}>Next: the admin accepts, sets up departments and imports the roster. The college goes live once its students start activating.</p>
      <div className="pilot-modal-actions"><button type="button" className="pilot-btn" onClick={overlay.closeModal}>Done</button></div>
    </div> : null}
  </div>;
}

export function OperationsColleges(): React.ReactElement {
  const overlay = useOverlay();
  const [added, setAdded] = useState<readonly College[]>([]);
  const rows = [...added, ...COLLEGES];
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Colleges" detail="Every college on ONE and where it is in onboarding.">
        <button type="button" className="pilot-btn" onClick={wired(() => overlay.openModal({ title: 'Onboard a College', subtitle: 'Organisation, checks and first admin', body: <OnboardCollegeBody onDone={(college) => setAdded((previous) => [college, ...previous])} /> }))}><Plus size={15} /> Onboard a College</button>
      </PageHead>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>College</th><th>City</th><th>Type</th><th>Students</th><th>Stage</th><th>College Admin</th></tr></thead>
          <tbody>
            {rows.map((college) => (
              <tr key={college.name}>
                <td><div className="pilot-person"><span className="pilot-mark slate" style={{ width: 34, height: 34, fontSize: 11.5 }}>{college.name.split(' ').map((word) => word[0]).join('').slice(0, 2)}</span><strong>{college.name}</strong></div></td>
                <td>{college.city}</td>
                <td>{college.kind}</td>
                <td>{college.students > 0 ? college.students.toLocaleString('en-IN') : '—'}</td>
                <td><span className={`pilot-chip ${STAGE_TONE[college.stage]}`}>{college.stage}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{college.admin}</small></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function OperationsEmployers(): React.ReactElement {
  const overlay = useOverlay();
  const [decisions, setDecisions] = useState<Readonly<Record<string, string>>>({});
  const review = (request: EmployerRequest): void => overlay.openModal({
    title: request.company, subtitle: `Access request · ${request.received}`, body: <div>
      <DetailRows rows={[['Requested by', request.requester], ['Received', request.received]]} />
      <div className="pilot-list" style={{ marginTop: 10 }}>
        {request.checks.map(([label, ok]) => (
          <div key={label} className="pilot-list-row" style={{ padding: '7px 2px' }}>
            <span className={`pilot-chip ${ok ? 'green' : 'rose'}`}>{ok ? 'Pass' : 'Check'}</span>
            <div className="grow"><small style={{ color: 'var(--p-ink-2)' }}>{label}</small></div>
          </div>
        ))}
      </div>
      <p className="pilot-modal-text" style={{ marginTop: 10 }}>A verified employer can publish roles, see applicants and request campus drives. Until then it can do none of these.</p>
      <div className="pilot-modal-actions">
        <button type="button" className="pilot-btn ghost" onClick={() => { overlay.closeModal(); setDecisions((previous) => ({ ...previous, [request.company]: 'More information requested' })); overlay.toast(`Asked ${request.company} for more information (sample).`); }}>Ask for More</button>
        <button type="button" className="pilot-btn" onClick={() => { overlay.closeModal(); setDecisions((previous) => ({ ...previous, [request.company]: 'Verified' })); overlay.toast(`${request.company} verified - they can now post roles (sample).`); }}>Verify Employer</button>
      </div>
    </div>,
  });
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Employer Verification" detail="Employers ask for access; operations checks who they are before they can hire on ONE." />
      <section className="pilot-card">
        <h2>Waiting for Review</h2>
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Company</th><th>Requested by</th><th>Checks</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {EMPLOYER_QUEUE.map((request) => {
              const decision = decisions[request.company];
              const passed = request.checks.filter(([, ok]) => ok).length;
              return <tr key={request.company}>
                <td><strong>{request.company}</strong></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{request.requester}</small></td>
                <td><span className={`pilot-chip ${passed === request.checks.length ? 'green' : 'amber'}`}>{passed} of {request.checks.length} pass</span></td>
                <td><span className={`pilot-chip ${decision === 'Verified' ? 'green' : decision ? 'amber' : 'slate'}`}>{decision ?? 'Pending'}</span></td>
                <td><button type="button" className="pilot-btn ghost small" disabled={Boolean(decision)} onClick={wired(() => review(request))}>{decision ? 'Done' : 'Review'}</button></td>
              </tr>;
            })}
          </tbody>
        </table></div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>Recently Verified</h2>
        <div className="pilot-list">
          {VERIFIED_EMPLOYERS.map(([company, detail]) => (
            <div key={company} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <ShieldCheck size={15} color="#0d6b4f" />
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{company}</strong><small>{detail}</small></div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}

export function OperationsInvitations(): React.ReactElement {
  const overlay = useOverlay();
  const [resent, setResent] = useState<ReadonlySet<string>>(new Set());
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Staff Invitations" detail="Invitations to college and employer staff, and whether they have been accepted.">
        <button type="button" className="pilot-btn" onClick={wired(() => overlay.openModal({
          title: 'Invite Staff', subtitle: 'The person signs in with this email to accept', body: <OverlayForm
            fields={[
              { label: 'Email', type: 'email', placeholder: 'name@college.example' },
              { label: 'Organisation', type: 'select', value: 'Hillcrest University', options: COLLEGES.map((college) => college.name) },
              { label: 'Role', type: 'select', value: 'Placement officer', options: ['College admin', 'Placement officer', 'Department head', 'Lecturer'] },
            ]}
            submitLabel="Send Invitation" success="Invitation sent (sample)." />,
        }))}><Plus size={15} /> Invite Staff</button>
      </PageHead>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Email</th><th>Role</th><th>Sent</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {INVITATIONS.map((invitation) => {
              const status = resent.has(invitation.email) ? 'Sent again' : invitation.status;
              return <tr key={invitation.email}>
                <td><strong>{invitation.email}</strong></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{invitation.role}</small></td>
                <td><small>{invitation.sent}</small></td>
                <td><span className={`pilot-chip ${status === 'Accepted' ? 'green' : status === 'Expired' ? 'rose' : 'blue'}`}>{status}</span></td>
                <td>{invitation.status === 'Accepted' ? null : <button type="button" className="pilot-btn ghost small" disabled={resent.has(invitation.email)} onClick={wired(() => { setResent((previous) => new Set(previous).add(invitation.email)); overlay.toast(`Invitation sent again to ${invitation.email} (sample).`); })}>Resend</button>}</td>
              </tr>;
            })}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function OperationsContent(): React.ReactElement {
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Question Bank" detail="The questions behind placement tests and practice. Every question is reviewed by a person before students see it." />
      <KpiRow items={[
        ['Published Questions', '5,040', 'blue', Library],
        ['Waiting for Review', QUESTION_BANKS.reduce((sum, bank) => sum + bank.review, 0), 'amber', ClipboardList],
        ['Subject Panels', 3, 'purple', Users],
      ]} />
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Question bank</th><th>Published</th><th>In review</th><th>Reviewed by</th></tr></thead>
          <tbody>
            {QUESTION_BANKS.map((bank) => (
              <tr key={bank.bank}>
                <td><strong>{bank.bank}</strong></td>
                <td>{bank.questions.toLocaleString('en-IN')}</td>
                <td><span className={`pilot-chip ${bank.review > 0 ? 'amber' : 'green'}`}>{bank.review > 0 ? `${bank.review} drafts` : 'Clear'}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{bank.owner}</small></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function OperationsAudit(): React.ReactElement {
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Audit Log" detail="Who did what, and when. Sensitive changes need a second person's approval and say who gave it." />
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {AUDIT.map((entry) => (
              <tr key={`${entry.when}-${entry.target}`}>
                <td><small>{entry.when}</small></td>
                <td>{entry.who}</td>
                <td><span className="pilot-chip slate">{entry.what}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{entry.target}</small></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}
