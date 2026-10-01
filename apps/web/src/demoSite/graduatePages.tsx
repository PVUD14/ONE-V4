/**
 * Demo-site graduate portal: Kavitha Selvam finished at the fictional Lakeview Institute
 * in 2022 and has been working since. ONE serves people who have already left college:
 * she asks Lakeview to verify her degree and marks, the college's academic team sees
 * her as a "Former student" (the lecturer demo shows the same request arriving), and
 * the verified record then sits on her profile for employers she chooses to share with.
 *
 * Fictional, demo-site only.
 */
import { useState } from 'react';
import { BadgeCheck, Building2, CheckCircle2, Clock, FileText, GraduationCap, Send, Share2, ShieldCheck, Upload } from 'lucide-react';
import { DetailRows, useOverlay } from '../pilot/pilotOverlay.js';
import { KpiRow, PageHead, wired } from './demoKit.js';

export const graduatePersona = {
  name: 'Kavitha Selvam',
  firstName: 'Kavitha',
  initials: 'KS',
  subtitle: 'B.Tech IT · Lakeview, Class of 2022',
  email: 'kavitha.selvam@mail.example',
} as const;

interface RecordRequest {
  readonly what: string;
  readonly college: string;
  readonly sent: string;
  readonly status: 'Waiting for college' | 'Verified';
}

const EARLIER_REQUESTS: readonly RecordRequest[] = [
  { what: 'Class XII marks', college: 'Sunrise Junior College', sent: 'Mar 2026', status: 'Verified' },
];

/** One shared list so Home, Verification and My Records agree within a session. */
function useRequests(): [readonly RecordRequest[], (request: RecordRequest) => void] {
  const [requests, setRequests] = useState<readonly RecordRequest[]>([]);
  return [requests, (request) => setRequests((previous) => [request, ...previous])];
}

export interface GraduateState {
  readonly requests: readonly RecordRequest[];
  readonly addRequest: (request: RecordRequest) => void;
}

export function useGraduateState(): GraduateState {
  const [requests, addRequest] = useRequests();
  return { requests, addRequest };
}

export function GraduateHome({ state, onNavigate }: { readonly state: GraduateState; readonly onNavigate: (key: string) => void }): React.ReactElement {
  const pending = state.requests.filter((request) => request.status === 'Waiting for college').length;
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title={`Welcome, ${graduatePersona.firstName}`} detail="You left college in 2022 - you can still get your records verified and use them in your career." />
      <KpiRow items={[
        ['Verified Records', 1, 'green', BadgeCheck],
        ['Requests Waiting', pending, 'amber', Clock],
        ['Profile Shares', 0, 'blue', Share2],
      ]} />
      <section className="pilot-hero">
        <div>
          <h2>Get your degree verified by Lakeview</h2>
          <p>Lakeview Institute of Technology is on ONE. Ask them to confirm your degree and marks - no visit to the college office.</p>
        </div>
        <button type="button" className="pilot-btn" onClick={wired(() => onNavigate('verification'))}><ShieldCheck size={15} /> Request Verification</button>
      </section>
      <section className="pilot-card">
        <h2>How it works</h2>
        <div className="pilot-row cols-4">
          {[
            ['1. Ask', 'Choose your college and what to verify', Send],
            ['2. College checks', 'Their academic team checks the archived register', Building2],
            ['3. Verified', 'The record is marked verified by the college', BadgeCheck],
            ['4. You share', 'Only with employers you choose', Share2],
          ].map(([title, detail, Icon]) => {
            const Component = Icon as typeof Send;
            return <div key={title as string} className="pilot-cat">
              <span className="pilot-tile blue"><Component size={15} /></span>
              <div><strong>{title as string}</strong><small>{detail as string}</small></div>
            </div>;
          })}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>Your Education</h2>
        <DetailRows rows={[['Degree', 'B.Tech Information Technology'], ['College', 'Lakeview Institute of Technology'], ['Years', '2018 – 2022'], ['Registration', 'LIT2022-0187']]} />
      </section>
      <section className="pilot-card">
        <h2>Now</h2>
        <DetailRows rows={[['Role', 'QA Analyst'], ['Company', 'Orbitech Solutions'], ['Since', 'Aug 2022']]} />
      </section>
    </aside>
  </div>;
}

/** The request flow: college, programme, what to verify, a supporting document, submit. */
export function GraduateVerification({ state }: { readonly state: GraduateState }): React.ReactElement {
  const overlay = useOverlay();
  const [step, setStep] = useState(0);
  const [items, setItems] = useState<ReadonlySet<string>>(new Set(['Degree awarded', 'Final CGPA']));
  const [attached, setAttached] = useState(false);
  const toggle = (item: string): void => setItems((previous) => {
    const next = new Set(previous);
    if (next.has(item)) next.delete(item); else next.add(item);
    return next;
  });
  const submit = (): void => {
    const what = [...items].join(', ') || 'Degree awarded';
    state.addRequest({ what, college: 'Lakeview Institute of Technology', sent: 'Today', status: 'Waiting for college' });
    setStep(4);
    overlay.toast('Request sent to Lakeview Institute of Technology (sample).');
  };
  const steps = ['College', 'Programme', 'What to verify', 'Document'];
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Verification" detail="Ask a college you studied at - even years ago - to confirm your records." />
      {step < 4 ? <section className="pilot-card">
        <div className="pilot-phases" style={{ marginBottom: 14 }}>
          {steps.map((label, index) => <span key={label} className={`pilot-phase ${index === step ? 'active' : ''}`}><strong>{index + 1}. {label}</strong></span>)}
        </div>
        {step === 0 ? <div>
          <label className="pilot-field"><span>College</span><select defaultValue="Lakeview Institute of Technology, Chennai"><option>Lakeview Institute of Technology, Chennai</option><option>Riverside College of Engineering, Tiruchirappalli</option><option>Hillcrest University, Coimbatore</option></select></label>
          <div className="pilot-banner"><CheckCircle2 size={16} /> Lakeview is on ONE - your request goes straight to its academic team.</div>
          <div className="pilot-modal-actions"><button type="button" className="pilot-btn" onClick={wired(() => setStep(1))}>Continue</button></div>
        </div> : null}
        {step === 1 ? <div>
          <div className="pilot-two">
            <label className="pilot-field"><span>Programme</span><input defaultValue="B.Tech Information Technology" /></label>
            <label className="pilot-field"><span>Registration number</span><input defaultValue="LIT2022-0187" /></label>
            <label className="pilot-field"><span>Joined</span><input defaultValue="2018" /></label>
            <label className="pilot-field"><span>Completed</span><input defaultValue="2022" /></label>
          </div>
          <div className="pilot-modal-actions">
            <button type="button" className="pilot-btn ghost" onClick={wired(() => setStep(0))}>Back</button>
            <button type="button" className="pilot-btn" onClick={wired(() => setStep(2))}>Continue</button>
          </div>
        </div> : null}
        {step === 2 ? <div>
          <div className="pilot-list">
            {['Degree awarded', 'Final CGPA', 'Semester 1–8 marks', 'Provisional certificate'].map((item) => (
              <div key={item} className="pilot-list-row" style={{ padding: '8px 2px' }}>
                <div className="grow"><small style={{ color: 'var(--p-ink-2)' }}>{item}</small></div>
                <button type="button" className={`pilot-btn small ${items.has(item) ? '' : 'ghost'}`} aria-pressed={items.has(item)} onClick={wired(() => toggle(item))}>{items.has(item) ? 'Selected' : 'Add'}</button>
              </div>
            ))}
          </div>
          <div className="pilot-modal-actions">
            <button type="button" className="pilot-btn ghost" onClick={wired(() => setStep(1))}>Back</button>
            <button type="button" className="pilot-btn" disabled={items.size === 0} onClick={wired(() => setStep(3))}>Continue</button>
          </div>
        </div> : null}
        {step === 3 ? <div>
          <p className="pilot-modal-text">A copy of your degree certificate helps the college find you faster. Only the college sees it.</p>
          <button type="button" className="pilot-btn ghost" onClick={wired(() => setAttached(true))}><Upload size={14} /> {attached ? 'degree-certificate.pdf attached' : 'Attach sample file: degree-certificate.pdf'}</button>
          <div className="pilot-modal-actions">
            <button type="button" className="pilot-btn ghost" onClick={wired(() => setStep(2))}>Back</button>
            <button type="button" className="pilot-btn" onClick={wired(submit)}><Send size={14} /> Send Request</button>
          </div>
        </div> : null}
      </section> : <section className="pilot-card">
        <div className="pilot-banner"><CheckCircle2 size={17} /> Sent. Lakeview's academic team now sees your request, marked as a former student.</div>
        <p className="pilot-modal-text" style={{ marginTop: 12 }}>Switch to the <strong>Lecturer</strong> demo and open <strong>Evidence &amp; Verification → Academic record requests</strong> to see it from the college's side.</p>
        <button type="button" className="pilot-btn ghost" style={{ marginTop: 8 }} onClick={wired(() => { setStep(0); setAttached(false); })}>Make Another Request</button>
      </section>}
      <section className="pilot-card">
        <h2>Your Requests</h2>
        <div className="pilot-list">
          {[...state.requests, ...EARLIER_REQUESTS].map((request) => (
            <div key={`${request.what}-${request.college}-${request.sent}`} className="pilot-list-row">
              <span className={`pilot-tile ${request.status === 'Verified' ? 'green' : 'amber'}`}>{request.status === 'Verified' ? <BadgeCheck size={16} /> : <Clock size={16} />}</span>
              <div className="grow"><strong>{request.what}</strong><small>{request.college} · sent {request.sent}</small></div>
              <span className={`pilot-chip ${request.status === 'Verified' ? 'green' : 'amber'}`}>{request.status}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>Good to know</h2>
        <div className="pilot-list">
          {[
            'Former students are served the same way as current students.',
            'The college gives a reason with every decision.',
            'Nothing is shared with an employer unless you choose to share it.',
          ].map((line) => (
            <div key={line} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <CheckCircle2 size={15} color="#0d6b4f" style={{ flexShrink: 0 }} />
              <small style={{ color: 'var(--p-ink-2)' }}>{line}</small>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}

export function GraduateRecords({ state }: { readonly state: GraduateState }): React.ReactElement {
  const overlay = useOverlay();
  const records = [
    { title: 'Class XII marks', source: 'Verified by Sunrise Junior College · Mar 2026', verified: true },
    ...state.requests.map((request) => ({ title: request.what, source: `${request.college} · waiting for the college`, verified: false })),
    { title: 'QA Analyst, Orbitech Solutions (2022 – now)', source: 'Self-declared', verified: false },
  ];
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="My Records" detail="Everything on your profile, and who confirmed it.">
        <button type="button" className="pilot-btn ghost" onClick={wired(() => overlay.openModal({
          title: 'Share Your Profile', subtitle: 'Link-only · you choose who gets it', body: <div>
            <DetailRows rows={[['Shows', 'Verified records and the work history you added'], ['Never shows', 'Requests still waiting, your phone number, documents you uploaded'], ['Link', 'one.example/p/kavitha-selvam (sample)']]} />
            <div className="pilot-modal-actions"><button type="button" className="pilot-btn" onClick={() => { overlay.closeModal(); overlay.toast('Profile link copied (sample).'); }}>Copy Link</button></div>
          </div>,
        }))}><Share2 size={15} /> Share Profile</button>
      </PageHead>
      <section className="pilot-card">
        <div className="pilot-list">
          {records.map((record) => (
            <div key={record.title} className="pilot-list-row">
              <span className={`pilot-tile ${record.verified ? 'green' : 'slate'}`}>{record.verified ? <BadgeCheck size={16} /> : record.title.includes('Orbitech') ? <FileText size={16} /> : <GraduationCap size={16} />}</span>
              <div className="grow"><strong>{record.title}</strong><small>{record.source}</small></div>
              <span className={`pilot-chip ${record.verified ? 'green' : 'slate'}`}>{record.verified ? 'Verified' : record.source === 'Self-declared' ? 'Self-declared' : 'Pending'}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  </div>;
}
